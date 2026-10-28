/**
 * Fault-injection proxy for TB4 smoke trials (docs/tb4-run-controller.md,
 * "Failure injection"). Sits between the bridge and Bedrock as a plain HTTP
 * forwarder to an upstream base URL and injects ONE fault on the Nth matching
 * request, then forwards everything else untouched:
 *
 *   reset     destroy the client socket after the first response bytes (dropped connection)
 *   cut       forward an SSE stream but stop before its terminal event, then close (stream cut)
 *   throttle  answer 429 ThrottlingException, as Bedrock does at a quota limit
 *   outage    refuse every request for --outage-sec seconds (network outage)
 *
 * Host restart is injected with `sudo reboot` on the trial host (run-injection.sh).
 *
 *   node --import tsx scripts/tb4-run/faults/fault-proxy.ts --upstream https://bedrock-runtime.us-east-1.amazonaws.com \
 *     --fault cut --nth 3 --port 8787 --log /opt/tb4/faults.log
 *
 * For a real smoke trial the bridge needs its Bedrock base URL pointed at the
 * proxy; SigV4 signs the Host header, so the proxy keeps the upstream Host.
 * The proxy never logs headers or bodies, only method, path, status, fault.
 *
 * Egress guard (docs/tb4-run-controller.md, "Preflight: outside dependencies"):
 * an HTTP(S) forward proxy that tunnels only to the model API host(s) and
 * refuses every other destination, logging each attempt (host and port only).
 * A smoke trial runs its bridge with HTTPS_PROXY/HTTP_PROXY pointed at it
 * (NODE_USE_ENV_PROXY=1 for Node's fetch); afterwards --verify-egress checks the
 * trial started, the bridge really went through the guard, and the bridge log
 * reports the expected context window:
 *
 *   node --import tsx scripts/tb4-run/faults/fault-proxy.ts --egress-allow bedrock-mantle.us-east-1.api.aws --port 8788 --log /opt/tb4/egress.log
 *   node --import tsx scripts/tb4-run/faults/fault-proxy.ts --verify-egress <trial dir> --egress-log /opt/tb4/egress.log \
 *     --model-host bedrock-mantle.us-east-1.api.aws --expect-window 400000
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Fault = "reset" | "cut" | "throttle" | "outage" | "none";
export type ProxyOptions = {
	upstream: string;
	fault: Fault;
	nth: number;
	outageSec?: number;
	log?: (line: string) => void;
};

export function startFaultProxy(
	opts: ProxyOptions,
	port = 0,
): Promise<{ server: Server; port: number; injected: () => number }> {
	let seen = 0;
	let injected = 0;
	let outageUntil = 0;
	const log = opts.log ?? (() => {});
	const server = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			seen++;
			const now = Date.now();
			const fire = opts.fault !== "none" && seen === opts.nth;
			if (fire && opts.fault === "outage")
				outageUntil = now + (opts.outageSec ?? 300) * 1000;
			if (now < outageUntil || (fire && opts.fault === "outage")) {
				injected++;
				log(
					JSON.stringify({
						at: new Date().toISOString(),
						n: seen,
						path: req.url,
						fault: "outage",
					}),
				);
				req.socket.destroy();
				return;
			}
			if (fire && opts.fault === "throttle") {
				injected++;
				log(
					JSON.stringify({
						at: new Date().toISOString(),
						n: seen,
						path: req.url,
						fault: "throttle",
						status: 429,
					}),
				);
				res.writeHead(429, {
					"content-type": "application/json",
					"x-amzn-errortype": "ThrottlingException",
				});
				res.end(
					JSON.stringify({
						message: "Too many requests, please wait before trying again.",
					}),
				);
				return;
			}
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers))
				if (typeof v === "string" && k !== "connection") headers.set(k, v);
			headers.set("host", new URL(opts.upstream).host);
			let upstream: Response;
			try {
				upstream = await fetch(new URL(req.url ?? "/", opts.upstream), {
					method: req.method,
					headers,
					body: chunks.length ? Buffer.concat(chunks) : undefined,
				});
			} catch (error) {
				res.writeHead(502).end(String(error).slice(0, 100));
				return;
			}
			res.writeHead(
				upstream.status,
				Object.fromEntries(
					[...upstream.headers].filter(
						([k]) =>
							![
								"content-length",
								"content-encoding",
								"transfer-encoding",
							].includes(k),
					),
				),
			);
			const reader = upstream.body?.getReader();
			let sent = 0;
			let buffer = "";
			const decoder = new TextDecoder();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				if (fire && opts.fault === "reset") {
					// Deliver part of the first chunk, then drop the connection mid-response.
					res.write(
						value.subarray(0, Math.max(1, Math.floor(value.length / 2))),
					);
					sent += Math.max(1, Math.floor(value.length / 2));
					injected++;
					log(
						JSON.stringify({
							at: new Date().toISOString(),
							n: seen,
							path: req.url,
							fault: "reset",
							afterBytes: sent,
						}),
					);
					reader.cancel().catch(() => {});
					res.socket?.destroy();
					return;
				}
				if (fire && opts.fault === "cut") {
					buffer += decoder.decode(value, { stream: true });
					// Forward complete events until the terminal one, then close cleanly with no error.
					const events = buffer.split("\n\n");
					buffer = events.pop() ?? "";
					for (const ev of events) {
						if (
							/response\.(completed|failed|incomplete)|\[DONE\]|message_stop/.test(
								ev,
							)
						) {
							injected++;
							log(
								JSON.stringify({
									at: new Date().toISOString(),
									n: seen,
									path: req.url,
									fault: "cut",
									afterBytes: sent,
								}),
							);
							reader.cancel().catch(() => {});
							res.end();
							return;
						}
						res.write(`${ev}\n\n`);
						sent += ev.length + 2;
					}
					continue;
				}
				res.write(value);
				sent += value.length;
			}
			if (buffer) res.write(buffer);
			res.end();
		},
	);
	return new Promise((resolve) =>
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				server,
				port: typeof address === "object" && address ? address.port : port,
				injected: () => injected,
			});
		}),
	);
}

export type EgressEntry = {
	at: string;
	method: string;
	host: string;
	port: number;
	allowed: boolean;
};

/** Whether `host` is allowed: an exact name, or a suffix entry starting with "." (".amazonaws.com"). */
export function egressAllowed(host: string, allow: readonly string[]) {
	const h = host.toLowerCase();
	return allow.some((a) => {
		const x = a.trim().toLowerCase();
		return x.startsWith(".") ? h.endsWith(x) : h === x;
	});
}

export function startEgressGuard(
	opts: { allow: string[]; log?: (line: string) => void },
	port = 0,
): Promise<{ server: Server; port: number; entries: () => EgressEntry[] }> {
	const entries: EgressEntry[] = [];
	const record = (method: string, host: string, p: number) => {
		const e = {
			at: new Date().toISOString(),
			method,
			host,
			port: p,
			allowed: egressAllowed(host, opts.allow),
		};
		entries.push(e);
		opts.log?.(JSON.stringify(e));
		return e.allowed;
	};
	const server = createServer(async (req, res) => {
		// A plain-HTTP proxy request carries an absolute URL.
		let target: URL;
		try {
			target = new URL(req.url ?? "");
		} catch {
			res.writeHead(400).end("absolute URL required");
			return;
		}
		if (
			!record(req.method ?? "GET", target.hostname, Number(target.port || 80))
		) {
			res.writeHead(403).end("egress blocked by the TB4 preflight guard");
			return;
		}
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers))
			if (
				typeof v === "string" &&
				!["connection", "proxy-connection"].includes(k)
			)
				headers.set(k, v);
		try {
			const up = await fetch(target, {
				method: req.method,
				headers,
				body: chunks.length ? Buffer.concat(chunks) : undefined,
			});
			res.writeHead(
				up.status,
				Object.fromEntries(
					[...up.headers].filter(
						([k]) =>
							![
								"content-length",
								"content-encoding",
								"transfer-encoding",
							].includes(k),
					),
				),
			);
			res.end(Buffer.from(await up.arrayBuffer()));
		} catch (error) {
			res.writeHead(502).end(String(error).slice(0, 100));
		}
	});
	server.on("connect", (req, socket, head) => {
		const [host, p] = (req.url ?? "").split(":");
		const portNumber = Number(p || 443);
		if (!host || !record("CONNECT", host, portNumber)) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const upstream = connect(portNumber, host, () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	return new Promise((resolve) =>
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				server,
				port: typeof address === "object" && address ? address.port : port,
				entries: () => [...entries],
			});
		}),
	);
}

/**
 * The context window the bridge reports, from a line such as
 * "context window 400000 (catalog)" in agent/ytimesy-bridge.log; the last one wins.
 * null when the bridge logs none (the harness must emit it; see the doc).
 */
export function contextWindowFromLog(text: string): number | null {
	let found: number | null = null;
	for (const m of text.matchAll(/context window\D{0,20}?(\d[\d_,]*)/gi))
		found = Number(m[1].replace(/[_,]/g, ""));
	return found;
}

/** Verdict of an egress-blocked smoke trial: it started, used the guard, and saw the right context window. */
export function egressPreflightVerdict(input: {
	bridgeLog: string | null;
	entries: EgressEntry[];
	modelHost: string;
	expectedContextWindow: number;
}) {
	const problems: string[] = [];
	const { bridgeLog } = input;
	if (bridgeLog === null)
		problems.push(
			"no agent/ytimesy-bridge.log: the trial never started the bridge",
		);
	else {
		const failed = bridgeLog
			.split("\n")
			.find(
				(l) =>
					l.startsWith("builder stopped:") ||
					l.startsWith("bridge failed before or outside the trial:"),
			);
		if (failed) problems.push(`the bridge stopped: ${failed.slice(0, 200)}`);
		const window = contextWindowFromLog(bridgeLog);
		if (window === null)
			problems.push(
				'the bridge log has no "context window <tokens>" line (the harness must log the window it resolved)',
			);
		else if (window !== input.expectedContextWindow)
			problems.push(
				`context window ${window}, expected ${input.expectedContextWindow} (a fallback was used)`,
			);
	}
	if (
		!input.entries.some(
			(e) =>
				e.allowed && e.host.toLowerCase() === input.modelHost.toLowerCase(),
		)
	)
		problems.push(
			`no request to ${input.modelHost} went through the guard: the bridge bypassed the proxy, so nothing was blocked (set HTTPS_PROXY and NODE_USE_ENV_PROXY=1)`,
		);
	const blocked = [
		...new Set(
			input.entries.filter((e) => !e.allowed).map((e) => `${e.host}:${e.port}`),
		),
	];
	return { ok: problems.length === 0, problems, blocked };
}

if (
	import.meta.url === `file://${process.argv[1]}` &&
	process.argv.some((a) => a === "--verify-egress" || a === "--egress-allow")
) {
	const { values } = parseArgs({
		options: {
			"verify-egress": { type: "string" },
			"egress-log": { type: "string" },
			"model-host": { type: "string" },
			"expect-window": { type: "string" },
			"egress-allow": { type: "string" },
			port: { type: "string", default: "8788" },
			log: { type: "string" },
		},
	});
	if (values["verify-egress"]) {
		const trialDir = values["verify-egress"];
		const bridge = join(trialDir, "agent", "ytimesy-bridge.log");
		const entries = existsSync(values["egress-log"] ?? "")
			? readFileSync(values["egress-log"]!, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as EgressEntry)
			: [];
		const verdict = egressPreflightVerdict({
			bridgeLog: existsSync(bridge) ? readFileSync(bridge, "utf8") : null,
			entries,
			modelHost: values["model-host"] ?? "",
			expectedContextWindow: Number(values["expect-window"]),
		});
		console.log(JSON.stringify(verdict, null, 2));
		process.exitCode = verdict.ok ? 0 : 1;
	} else {
		const logPath = values.log;
		const allow = (values["egress-allow"] ?? "").split(",").filter(Boolean);
		const { port } = await startEgressGuard(
			{
				allow,
				log: (line) =>
					logPath ? appendFileSync(logPath, `${line}\n`) : console.log(line),
			},
			Number(values.port),
		);
		console.log(`egress guard :${port}, allowing only ${allow.join(", ")}`);
	}
} else if (import.meta.url === `file://${process.argv[1]}`) {
	const { values } = parseArgs({
		options: {
			upstream: { type: "string" },
			fault: { type: "string", default: "none" },
			nth: { type: "string", default: "1" },
			"outage-sec": { type: "string", default: "300" },
			port: { type: "string", default: "8787" },
			log: { type: "string" },
		},
	});
	if (!values.upstream) throw new Error("--upstream required");
	const logPath = values.log;
	const { port } = await startFaultProxy(
		{
			upstream: values.upstream,
			fault: values.fault as Fault,
			nth: Number(values.nth),
			outageSec: Number(values["outage-sec"]),
			log: (line) =>
				logPath ? appendFileSync(logPath, `${line}\n`) : console.log(line),
		},
		Number(values.port),
	);
	console.log(
		`fault proxy :${port} -> ${values.upstream} (${values.fault} on request ${values.nth})`,
	);
}
