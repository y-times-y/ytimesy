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
 */
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

export type Fault = "reset" | "cut" | "throttle" | "outage" | "none";
export type ProxyOptions = { upstream: string; fault: Fault; nth: number; outageSec?: number; log?: (line: string) => void };

export function startFaultProxy(opts: ProxyOptions, port = 0): Promise<{ server: Server; port: number; injected: () => number }> {
	let seen = 0;
	let injected = 0;
	let outageUntil = 0;
	const log = opts.log ?? (() => {});
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		seen++;
		const now = Date.now();
		const fire = opts.fault !== "none" && seen === opts.nth;
		if (fire && opts.fault === "outage") outageUntil = now + (opts.outageSec ?? 300) * 1000;
		if (now < outageUntil || (fire && opts.fault === "outage")) {
			injected++;
			log(JSON.stringify({ at: new Date().toISOString(), n: seen, path: req.url, fault: "outage" }));
			req.socket.destroy();
			return;
		}
		if (fire && opts.fault === "throttle") {
			injected++;
			log(JSON.stringify({ at: new Date().toISOString(), n: seen, path: req.url, fault: "throttle", status: 429 }));
			res.writeHead(429, { "content-type": "application/json", "x-amzn-errortype": "ThrottlingException" });
			res.end(JSON.stringify({ message: "Too many requests, please wait before trying again." }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "connection") headers.set(k, v);
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
		res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["content-length", "content-encoding", "transfer-encoding"].includes(k))));
		const reader = upstream.body?.getReader();
		let sent = 0;
		let buffer = "";
		const decoder = new TextDecoder();
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			if (fire && opts.fault === "reset") {
				// Deliver part of the first chunk, then drop the connection mid-response.
				res.write(value.subarray(0, Math.max(1, Math.floor(value.length / 2))));
				sent += Math.max(1, Math.floor(value.length / 2));
				injected++;
				log(JSON.stringify({ at: new Date().toISOString(), n: seen, path: req.url, fault: "reset", afterBytes: sent }));
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
					if (/response\.(completed|failed|incomplete)|\[DONE\]|message_stop/.test(ev)) {
						injected++;
						log(JSON.stringify({ at: new Date().toISOString(), n: seen, path: req.url, fault: "cut", afterBytes: sent }));
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
	});
	return new Promise((resolve) =>
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, port: typeof address === "object" && address ? address.port : port, injected: () => injected });
		}),
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
			log: (line) => (logPath ? appendFileSync(logPath, `${line}\n`) : console.log(line)),
		},
		Number(values.port),
	);
	console.log(`fault proxy :${port} -> ${values.upstream} (${values.fault} on request ${values.nth})`);
}
