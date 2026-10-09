import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { handleCodexSubscriptionRelay } from "../src/server/adapters/codex-subscription-transport";
import { closeDatabase } from "../src/server/adapters/database";

if (process.env.EDGE_RELAY_PROOF !== "1")
	throw new Error("Enable EDGE_RELAY_PROOF=1.");
const secret = randomUUID() + randomUUID();
process.env.YTIMESY_CODEX_RELAY_SECRET = secret;
const configuration = "wrangler.edge-executor.jsonc";
function wrangler(args: string[]) {
	try {
		return execFileSync(
			"pnpm",
			["exec", "wrangler", ...args, "--config", configuration],
			{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 },
		);
	} catch {
		throw new Error("Relay proof control failed; secret output withheld.");
	}
}
const server = createServer(async (incoming, outgoing) => {
	const abort = new AbortController();
	outgoing.on("close", () => {
		if (!outgoing.writableEnded) abort.abort();
	});
	try {
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of incoming) {
			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) {
				outgoing.writeHead(413).end();
				return;
			}
			chunks.push(Buffer.from(chunk));
		}
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers))
			if (typeof value === "string") headers.set(key, value);
		const request = new Request(`http://127.0.0.1${incoming.url}`, {
			method: incoming.method,
			headers,
			body: Buffer.concat(chunks).toString("utf8"),
			signal: abort.signal,
		});
		const response = await handleCodexSubscriptionRelay(request);
		console.log(JSON.stringify({ relayRequestStatus: response.status }));
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		if (response.body)
			await pipeline(Readable.from(responseChunks(response.body)), outgoing);
		else outgoing.end();
	} catch {
		if (!outgoing.headersSent) outgoing.writeHead(502);
		outgoing.end();
	}
});
async function* responseChunks(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return;
			yield chunk.value;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}
let tunnel: ChildProcess | undefined;
let modified = false;
try {
	const listed = JSON.parse(wrangler(["secret", "list"])) as { name: string }[];
	if (
		listed.some((row) =>
			["YTIMESY_CODEX_RELAY_URL", "YTIMESY_CODEX_RELAY_SECRET"].includes(
				row.name,
			),
		)
	)
		throw new Error(
			"Existing relay configuration must not be overwritten by this proof.",
		);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Relay did not listen.");
	tunnel = spawn(
		"cloudflared",
		["tunnel", "--url", `http://127.0.0.1:${address.port}`, "--no-autoupdate"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let origin = "";
	tunnel.stderr?.on("data", (data) => {
		if (String(data).includes("Registered tunnel connection"))
			console.log("Disposable tunnel connection registered.");
		if (String(data).includes("failed"))
			console.log("Disposable tunnel reported a connection failure.");
		const match = String(data).match(
			/https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
		);
		if (match) origin = match[0];
	});
	for (let attempt = 0; attempt < 30 && !origin; attempt++) await delay(1000);
	if (!origin) throw new Error("Disposable proof tunnel did not become ready.");
	const preflightUrl = `${origin}/api/internal/codex-transport`;
	let addresses: string[] = [];
	for (let attempt = 0; attempt < 30 && !addresses.length; attempt++) {
		const response = await fetch(
			`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: new URL(origin).hostname, type: "A" })}`,
			{
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(5000),
			},
		);
		const records = (await response.json()) as {
			Answer?: { type: number; data: string }[];
		};
		addresses = (records.Answer ?? [])
			.filter(
				(row) => row.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(row.data),
			)
			.map((row) => row.data);
		if (!addresses.length) await delay(2000);
	}
	if (!addresses.length)
		throw new Error("Public proof tunnel DNS did not become ready.");
	console.log(JSON.stringify({ publicTunnelDnsAddresses: addresses.length }));
	const preflightBody = JSON.stringify({
		userId: "missing-proof-owner",
		operation: { kind: "identity" },
	});
	let ready = false;
	for (let attempt = 0; attempt < 15; attempt++) {
		try {
			const headers = await signDeliveryRequest(
				secret,
				"POST",
				preflightUrl,
				preflightBody,
			);
			const configuration = [
				`url = ${JSON.stringify(preflightUrl)}`,
				'request = "POST"',
				`data = ${JSON.stringify(preflightBody)}`,
				...Object.entries(headers).map(
					([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`,
				),
			].join("\n");
			const curl = spawn(
				"curl",
				[
					"--config",
					"-",
					"--silent",
					"--max-time",
					"5",
					"--output",
					"/dev/null",
					"--write-out",
					"%{http_code}",
					"--resolve",
					`${new URL(origin).hostname}:443:${addresses[0]}`,
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			let status = "";
			curl.stdout.on("data", (chunk) => {
				status += String(chunk);
			});
			curl.stdin.end(configuration);
			if (
				(await new Promise<number | null>((resolve) =>
					curl.on("exit", resolve),
				)) !== 0
			)
				throw new Error("Tunnel preflight connection failed.");
			ready = status === "502";
			console.log(JSON.stringify({ relayPreflightStatus: status }));
			if (ready) break;
		} catch (error) {
			const code =
				error instanceof Error &&
				error.cause &&
				typeof error.cause === "object" &&
				"code" in error.cause
					? error.cause.code
					: "unknown";
			console.log(
				JSON.stringify({
					relayPreflightFailure: [
						"ENOTFOUND",
						"ECONNREFUSED",
						"ETIMEDOUT",
					].includes(String(code))
						? code
						: "transport",
				}),
			);
		}
		await delay(1000);
	}
	if (!ready) throw new Error("Signed relay tunnel preflight failed.");
	const env = {
		...process.env,
		YTIMESY_CODEX_RELAY_URL: `${origin}/api/internal/codex-transport`,
		EDGE_LIVE_PROOF: "1",
	};
	// Same production handler through a disposable tunnel; not a production hosting claim.
	modified = true;
	const deploy = spawn(
		"node",
		[
			"--env-file=.env",
			"--import",
			"tsx",
			"scripts/deploy-edge-development.ts",
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	deploy.stdout?.on("data", (data) => process.stdout.write(data));
	if (
		(await new Promise<number | null>((resolve) =>
			deploy.on("exit", resolve),
		)) !== 0
	)
		throw new Error("Edge relay deployment failed; secret output withheld.");
	const proof = spawn(
		"node",
		["--env-file=.env", "--import", "tsx", "scripts/verify-edge-live-turn.ts"],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	proof.stdout?.on("data", (data) => process.stdout.write(data));
	if (
		(await new Promise<number | null>((resolve) =>
			proof.on("exit", resolve),
		)) !== 0
	)
		throw new Error(
			"Live relay proof failed; isolated trace cleanup was attempted.",
		);
} finally {
	const failures: string[] = [];
	if (modified)
		for (const name of [
			"YTIMESY_CODEX_RELAY_URL",
			"YTIMESY_CODEX_RELAY_SECRET",
		]) {
			try {
				wrangler(["secret", "delete", name]);
			} catch {
				failures.push(name);
			}
		}
	tunnel?.kill("SIGTERM");
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await closeDatabase();
	if (failures.length) {
		process.exitCode = 1;
		console.error("Relay configuration cleanup failed.");
	}
	console.log(
		"Disposable relay tunnel closed; development relay configuration removed.",
	);
}
