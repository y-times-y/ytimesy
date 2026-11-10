// The runner box's API: the three operations the Claude Code runner needs on
// the machine it starts `claude` on (run a shell command, write a file, read a
// file), for the edge to call over HTTPS. The box holds no repository code and
// no user secrets: only `claude` and the short-lived per-turn grants the
// runner writes for it. Requests carry the repo's delivery signature
// (src/domain/delivery-auth.ts) plus a single-use nonce.
import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve, sep } from "node:path";

const EXPIRY_HEADER = "x-ytimesy-delivery-expires";
const SIGNATURE_HEADER = "x-ytimesy-delivery-signature";
const NONCE_HEADER = "x-ytimesy-runner-nonce";
const MAX_BODY = 32 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_EXEC_MS = 15 * 60_000;

function sign(secret, method, target, expires, nonce, body) {
	const hash = createHash("sha256").update(body).digest("hex");
	return createHmac("sha256", secret)
		.update(`${method}\n${target}\n${expires}\n${hash}\n${nonce}`)
		.digest("hex");
}

/** The signature the edge must send; exported so the edge client signs the same bytes. */
export const runnerSignature = sign;

/** Share of the disk holding `home` that is used (0-1). */
async function diskUsedShare(home) {
	const info = await statfs(home);
	return 1 - info.bavail / info.blocks;
}

/** Above this share the box logs a warning; the edge refuses new runs at 95% (runnerFull in the app). */
export const DISK_WARN_SHARE = 0.8;
const WARN_EVERY_MS = 5 * 60_000;

export function createRunnerServer({ secret, home, now = Date.now, disk = diskUsedShare }) {
	if (!secret || secret.length < 32) throw new Error("Runner signing key is too short.");
	const root = resolve(home);
	const seen = new Map();
	let lastWarning = 0;
	const inside = (path) => {
		const full = resolve(root, path);
		return full === root || full.startsWith(root + sep) ? full : null;
	};
	const authorized = (request, body) => {
		const expires = request.headers[EXPIRY_HEADER] ?? "";
		const signature = request.headers[SIGNATURE_HEADER] ?? "";
		const nonce = request.headers[NONCE_HEADER] ?? "";
		const at = now();
		if (!/^\d{13}$/.test(expires) || Number(expires) <= at || Number(expires) > at + 65_000) return false;
		if (!/^[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{32}$/.test(nonce)) return false;
		const expected = sign(secret, request.method, request.url, expires, nonce, body);
		if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
		for (const [key, until] of seen) if (until <= at) seen.delete(key);
		if (seen.has(nonce)) return false;
		seen.set(nonce, Number(expires));
		return true;
	};
	const exec = (command, timeoutMs) =>
		new Promise((done) => {
			const environment = { ...process.env, HOME: root };
			// Host authentication must never become a credential of the agent process.
			delete environment.RUNNER_SIGNING_KEY;
			const child = spawn("bash", ["-c", command], { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			const take = (current, chunk) => (current.length < MAX_OUTPUT ? current + chunk : current);
			child.stdout.on("data", (chunk) => (stdout = take(stdout, chunk)));
			child.stderr.on("data", (chunk) => (stderr = take(stderr, chunk)));
			const timer = setTimeout(() => {
				// Kill this short exec's whole group, not a detached Claude run.
				try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error) {
					if (error.code !== "ESRCH") child.kill("SIGKILL");
				}
			}, Math.min(timeoutMs, MAX_EXEC_MS));
			child.once("error", (error) => {
				clearTimeout(timer);
				done({ exitCode: 1, stdout, stderr: `Runner command could not start (${error.code ?? error.name}).` });
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				done({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr });
			});
		});
	return createServer(async (request, response) => {
		const reply = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		try {
			if (request.method === "GET" && request.url === "/health") {
				const share = await disk(root);
				if (share >= DISK_WARN_SHARE && now() - lastWarning >= WARN_EVERY_MS) {
					lastWarning = now();
					console.warn(JSON.stringify({ level: "warn", message: "Runner disk above 80% used", usedShare: Number(share.toFixed(3)) }));
				}
				return reply(200, { ok: true, disk: { usedShare: Number(share.toFixed(4)) } });
			}
			let size = 0;
			const chunks = [];
			for await (const chunk of request) {
				size += chunk.length;
				if (size > MAX_BODY) return reply(413, { error: "too large" });
				chunks.push(chunk);
			}
			const body = Buffer.concat(chunks).toString("utf8");
			if (request.method !== "POST" || !authorized(request, body)) return reply(403, { error: "forbidden" });
			const input = JSON.parse(body || "{}");
			if (request.url === "/exec") {
				if (typeof input.command !== "string") return reply(400, { error: "command" });
				return reply(200, await exec(input.command, Number(input.timeoutMs) || 60_000));
			}
			if (request.url === "/write") {
				const path = typeof input.path === "string" ? inside(input.path) : null;
				if (!path || typeof input.contents !== "string") return reply(400, { error: "path" });
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, input.contents, { mode: 0o600 });
				return reply(200, { ok: true });
			}
			if (request.url === "/read") {
				const path = typeof input.path === "string" ? inside(input.path) : null;
				if (!path) return reply(400, { error: "path" });
				return reply(200, { contents: await readFile(path, "utf8") });
			}
			return reply(404, { error: "not found" });
		} catch (error) {
			return reply(500, { error: error instanceof Error ? error.code ?? error.name : "error" });
		}
	});
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const secret = process.env.RUNNER_SIGNING_KEY ?? "";
	const home = process.env.RUNNER_HOME ?? "/var/lib/ytimesy-runner";
	createRunnerServer({ secret, home }).listen(Number(process.env.PORT ?? 8787), "127.0.0.1");
}
