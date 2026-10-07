import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createParser } from "eventsource-parser";
import { z } from "zod";

const configuration = z.object({
	accessToken: z.string().min(1),
	accountId: z.string().min(1),
	proofToken: z.string().min(32),
	modelId: z.string().min(1),
	reasoning: z.string().min(1),
	durationSeconds: z.number().int().positive(),
	modelRequests: z.number().int().positive(),
	tokens: z.number().int().positive(),
});
export type NativeBudgetConfiguration = z.infer<typeof configuration>;
const completedResponse = z.object({
	type: z.literal("response.completed"),
	response: z.object({
		id: z.string().min(1),
		usage: z.object({
			input_tokens: z.number().int().nonnegative(),
			output_tokens: z.number().int().nonnegative(),
		}),
	}),
});

async function boundedBody(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 8_000_000) throw new Error("Request body exceeds proof limit.");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** Operator-only guest transport guard, not a security boundary against guest root. */
export function nativeBudgetProxy(
	input: NativeBudgetConfiguration,
	options: {
		transport?: typeof fetch;
		persist?: (state: unknown) => Promise<void>;
	} = {},
) {
	const config = configuration.parse(input);
	const deadline = Date.now() + config.durationSeconds * 1000;
	const transport = options.transport ?? fetch;
	const state = {
		requests: 0,
		observedTokens: 0,
		stopped: false,
		inFlight: false,
		failureStage: null as string | null,
		upstreamStatus: null as number | null,
	};
	const persist = async () => options.persist?.({ ...state, deadline });
	const server = createServer(async (request, response) => {
		const reject = (status: number) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message: "Native evaluation transport rejected the request.",
					},
				}),
			);
		};
		if (request.method !== "POST" || request.url !== "/v1/responses")
			return reject(404);
		if (request.headers.authorization !== `Bearer ${config.proofToken}`)
			return reject(401);
		if (
			state.stopped ||
			state.inFlight ||
			Date.now() >= deadline ||
			state.requests >= config.modelRequests ||
			state.observedTokens >= config.tokens
		)
			return reject(429);
		// Reserve before awaiting body/transport, so simultaneous requests cannot bypass limits.
		state.inFlight = true;
		const abort = new AbortController();
		response.on("close", () => {
			if (!response.writableEnded) abort.abort();
		});
		let accounted = false;
		let stage = "request-validation";
		try {
			const body = await boundedBody(request);
			const parsed = z
				.object({
					model: z.literal(config.modelId),
					reasoning: z.object({ effort: z.literal(config.reasoning) }),
					stream: z.literal(true),
					service_tier: z.enum(["auto", "default"]).optional(),
				})
				.parse(JSON.parse(body.toString("utf8")));
			if (!parsed) return reject(400);
			if (Date.now() >= deadline) return reject(429);
			state.requests += 1;
			stage = "request-persistence";
			await persist();
			stage = "upstream-request";
			const upstream = await transport(
				"https://chatgpt.com/backend-api/codex/responses",
				{
					method: "POST",
					body,
					redirect: "error",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${config.accessToken}`,
						"ChatGPT-Account-ID": config.accountId,
						originator: "codex_cli_rs",
						accept: "text/event-stream",
					},
					signal: AbortSignal.any([
						abort.signal,
						AbortSignal.timeout(Math.max(1, deadline - Date.now())),
					]),
				},
			);
			if (!upstream.ok || !upstream.body) {
				state.stopped = true;
				state.failureStage = "upstream-http";
				state.upstreamStatus = upstream.status;
				await upstream.body?.cancel();
				return reject(502);
			}
			stage = "response-stream";
			const parser = createParser({
				maxBufferSize: 4_000_000,
				onError: (error) => {
					if (error.type === "max-buffer-size-exceeded") throw error;
				},
				onEvent: (event) => {
					if (accounted || event.data === "[DONE]") return;
					const value = JSON.parse(event.data);
					if (value.type !== "response.completed") return;
					const usage = completedResponse.parse(value).response.usage;
					state.observedTokens += usage.input_tokens + usage.output_tokens;
					accounted = true;
				},
			});
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			const decoder = new TextDecoder();
			for await (const chunk of upstream.body) {
				parser.feed(decoder.decode(chunk, { stream: true }));
				if (!response.write(chunk))
					await once(response, "drain", { signal: abort.signal });
				if (accounted) break;
			}
			parser.feed(decoder.decode());
			if (!accounted) {
				state.stopped = true;
				state.failureStage = "missing-usage";
			}
			stage = "usage-persistence";
			await persist();
			response.end();
		} catch {
			if (!accounted || stage === "usage-persistence") {
				state.stopped = true;
				state.failureStage = stage;
			}
			if (response.headersSent) response.destroy();
			else reject(400);
		} finally {
			state.inFlight = false;
			await persist().catch(() => {
				state.stopped = true;
				state.failureStage = "final-persistence";
			});
		}
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;
	return { server, snapshot: () => ({ ...state, deadline }) };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const [configPath, statePath, portPath] = process.argv.slice(2);
	if (!configPath || !statePath || !portPath)
		throw new Error("Expected private configuration, state and port paths.");
	const proxy = nativeBudgetProxy(
		JSON.parse(await readFile(configPath, "utf8")),
		{
			persist: async (state) => {
				await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
			},
		},
	);
	proxy.server.listen(0, "127.0.0.1");
	await once(proxy.server, "listening");
	const address = proxy.server.address();
	if (!address || typeof address === "string")
		throw new Error("Proxy listener unavailable.");
	await writeFile(portPath, String(address.port), { mode: 0o600 });
}
