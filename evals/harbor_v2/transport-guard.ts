import { appendFileSync, writeFileSync } from "node:fs";
import {
	DEGENERATE_RUN_CHARS,
	DegenerateOutput,
	whitespaceRun,
} from "#/domain/degenerate-output";

export { DEGENERATE_RUN_CHARS, DegenerateOutput, whitespaceRun };

/**
 * Provider-neutral transport guard for Harbor bridge v2 (successor of the
 * OpenAI-only .ytimesy/harbor-jobs/rerun-20261013/transport-guard.cjs).
 *
 * For a streamed model request it holds the response until the stream's
 * terminal event arrives, then hands the whole stream to the caller
 * unchanged:
 *   - OpenAI Responses (API and the Codex subscription endpoint):
 *     response.completed / response.incomplete / response.failed / error
 *   - Anthropic Messages: message_stop / error
 *   - Gemini streamGenerateContent: a chunk with a finishReason, or an error
 * If the provider closes the stream without one (seen intermittently on
 * OpenAI, 2026-10-13: a clean close mid-delta), nothing has reached the
 * agent yet, so the identical request is sent again (at most maxAttempts
 * times). The harness's streamRetries: 0 therefore never sees a partial
 * response. Each call is logged as one JSON line (request id, status,
 * timings, terminal event; on a cut also the last event types, the last
 * 4 KB of stream text and the request body in a side file). Credentials are
 * never logged: only the URL path, response headers' request id and the
 * stream itself are recorded.
 *
 * A response whose streamed output degenerates into a long run of whitespace
 * (a tool call's arguments or answer text; Luna on Bedrock once streamed 64K
 * tokens of blank lines inside one run_code call, 15-17 MB over 6-8.5
 * minutes, until max_output_tokens) is cut as soon as the run passes
 * `degenerateRunChars` and resent like a cut stream (the detection is
 * shared with the product's model loop: src/domain/degenerate-output.ts).
 *
 * Cost note: a retried cut request was already billed by the provider; its
 * usage never reaches the harness, so the trial's estimate undercounts it.
 * The log records every cut so an operator can add it.
 */

export type StreamKind = "openai" | "anthropic" | "google";

export function streamKind(
	url: string,
	body: string | null,
): StreamKind | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const path = parsed.pathname;
	if (/:streamGenerateContent$/.test(path)) return "google";
	if (body === null || !/"stream"\s*:\s*true/.test(body)) return null;
	if (/\/responses$/.test(path)) return "openai";
	if (/\/v1\/messages$/.test(path)) return "anthropic";
	return null;
}

export type TerminalEvent = {
	type: string;
	error?: unknown;
	status?: string;
};

/** The terminal event one SSE data payload carries, if it is one. */
export function terminalEvent(
	kind: StreamKind,
	data: string,
): TerminalEvent | null {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(data);
	} catch {
		return null;
	}
	if (!event || typeof event !== "object") return null;
	const type = typeof event.type === "string" ? event.type : "";
	if (kind === "openai") {
		if (
			![
				"response.completed",
				"response.incomplete",
				"response.failed",
				"error",
			].includes(type)
		)
			return null;
		const response = (event.response ?? {}) as Record<string, unknown>;
		return {
			type,
			status: typeof response.status === "string" ? response.status : undefined,
			error:
				response.error ??
				event.error ??
				(event.code ? { code: event.code, message: event.message } : undefined),
		};
	}
	if (kind === "anthropic") {
		if (type === "message_stop") return { type };
		if (type === "error") return { type, error: event.error };
		return null;
	}
	if (event.error) return { type: "error", error: event.error };
	const candidates = Array.isArray(event.candidates) ? event.candidates : [];
	const finish = candidates.find(
		(candidate: { finishReason?: unknown }) =>
			typeof candidate?.finishReason === "string",
	) as { finishReason: string } | undefined;
	return finish ? { type: "finish", status: finish.finishReason } : null;
}

/** The output text one SSE data payload streams (answer text or tool-call arguments), if any. */
export function outputDelta(kind: StreamKind, data: string): string | null {
	if (kind === "google" || !/delta/.test(data)) return null;
	let event: { type?: unknown; delta?: unknown };
	try {
		event = JSON.parse(data);
	} catch {
		return null;
	}
	if (kind === "openai")
		return (event.type === "response.output_text.delta" ||
			event.type === "response.function_call_arguments.delta" ||
			event.type === "response.custom_tool_call_input.delta") &&
			typeof event.delta === "string"
			? event.delta
			: null;
	if (event.type !== "content_block_delta") return null;
	const delta = (event.delta ?? {}) as {
		text?: unknown;
		partial_json?: unknown;
	};
	return typeof delta.text === "string"
		? delta.text
		: typeof delta.partial_json === "string"
			? delta.partial_json
			: null;
}

type Drained = {
	chunks: Uint8Array[];
	degenerate: DegenerateOutput | null;
	terminal: TerminalEvent | null;
	error: unknown;
	bytes: number;
	maxGapMs: number;
	eventTypes: string[];
	rawTail: string;
	sinceLastChunkMs: number;
};

async function drain(
	kind: StreamKind,
	body: ReadableStream<Uint8Array>,
	degenerateRunChars: number,
): Promise<Drained> {
	const run = whitespaceRun();
	let degenerate: DegenerateOutput | null = null;
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	const eventTypes: string[] = [];
	let lineBuffer = "";
	let rawTail = "";
	let terminal: TerminalEvent | null = null;
	let bytes = 0;
	let last = Date.now();
	let maxGapMs = 0;
	let error: unknown = null;
	const reader = body.getReader();
	const line = (text: string) => {
		if (!text.startsWith("data:")) return;
		const data = text.slice(5).trim();
		const type = /"type"\s*:\s*"([^"]+)"/.exec(data)?.[1];
		if (type && eventTypes.at(-1) !== type) {
			eventTypes.push(type);
			if (eventTypes.length > 10) eventTypes.shift();
		}
		terminal = terminalEvent(kind, data) ?? terminal;
		const delta = outputDelta(kind, data);
		if (delta !== null && !degenerate) {
			const length = run(delta);
			if (length >= degenerateRunChars)
				degenerate = new DegenerateOutput(length);
		}
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const now = Date.now();
			maxGapMs = Math.max(maxGapMs, now - last);
			last = now;
			bytes += value.byteLength;
			chunks.push(value);
			const text = decoder.decode(value, { stream: true });
			rawTail = (rawTail + text).slice(-4096);
			lineBuffer += text;
			for (
				let index = lineBuffer.indexOf("\n");
				index >= 0;
				index = lineBuffer.indexOf("\n")
			) {
				line(lineBuffer.slice(0, index).replace(/\r$/, ""));
				lineBuffer = lineBuffer.slice(index + 1);
			}
			if (degenerate) {
				await reader.cancel(degenerate).catch(() => {});
				break;
			}
		}
		if (lineBuffer) line(lineBuffer);
	} catch (caught) {
		error = caught;
	}
	return {
		chunks,
		degenerate,
		terminal: degenerate ? null : terminal,
		error: degenerate ?? error,
		bytes,
		maxGapMs,
		eventTypes,
		rawTail,
		sinceLastChunkMs: Date.now() - last,
	};
}

function replay(response: Response, chunks: Uint8Array[], error?: unknown) {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				if (error) controller.error(error);
				else controller.close();
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

function errorChain(error: unknown) {
	const out: { name?: string; code?: unknown; message: string }[] = [];
	let current = error as
		| { name?: string; code?: unknown; message?: unknown; cause?: unknown }
		| undefined;
	for (let depth = 0; current && depth < 6; depth++) {
		out.push({
			name: current.name,
			code: current.code,
			message: String(current.message ?? current).slice(0, 300),
		});
		current = current.cause as typeof current;
	}
	return out;
}

const requestIdOf = (headers: Headers) =>
	headers.get("x-request-id") ??
	headers.get("request-id") ??
	headers.get("x-goog-request-id") ??
	headers.get("x-amzn-requestid") ??
	null;

export function guardedFetch(
	original: typeof globalThis.fetch,
	options: {
		logPath?: string;
		maxAttempts?: number;
		/** Back-off before a resend; tests pass 0. */
		delayMs?: (attempt: number) => number;
		/** Whitespace run in streamed output that cuts the response (DEGENERATE_RUN_CHARS). */
		degenerateRunChars?: number;
	} = {},
): typeof globalThis.fetch {
	const maxAttempts = options.maxAttempts ?? 3;
	const degenerateRunChars = options.degenerateRunChars ?? DEGENERATE_RUN_CHARS;
	const delayMs = options.delayMs ?? ((attempt: number) => 2000 * attempt);
	const record = (entry: Record<string, unknown>) => {
		if (!options.logPath) return;
		try {
			appendFileSync(
				options.logPath,
				`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
			);
		} catch {}
	};
	const keepBody = (body: string, requestId: string | null) => {
		if (!options.logPath) return null;
		const file = `${options.logPath}.${requestId ?? Date.now()}.request.json`;
		try {
			writeFileSync(file, body);
			return file;
		} catch {
			return null;
		}
	};
	return async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const body = typeof init?.body === "string" ? init.body : null;
		const kind = streamKind(url, body);
		if (!kind) return original(input, init);
		const path = new URL(url).pathname;
		let last: { response: Response; drained: Drained } | null = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const started = Date.now();
			let response: Response;
			try {
				response = await original(input, init);
			} catch (error) {
				record({
					phase: "request",
					kind,
					path,
					attempt,
					ms: Date.now() - started,
					errors: errorChain(error),
				});
				throw error;
			}
			const requestId = requestIdOf(response.headers);
			if (!response.ok || !response.body) {
				record({
					phase: "response",
					kind,
					path,
					attempt,
					requestId,
					status: response.status,
					ms: Date.now() - started,
				});
				return response;
			}
			const drained = await drain(kind, response.body, degenerateRunChars);
			const base = {
				kind,
				path,
				attempt,
				requestId,
				status: response.status,
				ms: Date.now() - started,
				bytes: drained.bytes,
				maxGapMs: drained.maxGapMs,
			};
			if (drained.terminal && !drained.error) {
				record({ phase: "stream", ...base, terminal: drained.terminal });
				return replay(response, drained.chunks);
			}
			const aborted = init?.signal?.aborted === true;
			record({
				phase: drained.degenerate
					? "degenerate"
					: drained.error
						? "stream-error"
						: "stream-cut",
				...base,
				terminal: drained.terminal ?? "none",
				errors: drained.error ? errorChain(drained.error) : undefined,
				sinceLastChunkMs: drained.sinceLastChunkMs,
				eventTypes: drained.eventTypes,
				rawTail: drained.rawTail,
				requestBody: body ? keepBody(body, requestId) : null,
				willRetry: !aborted && attempt < maxAttempts,
			});
			if (aborted && drained.error) throw drained.error;
			last = { response, drained };
			if (aborted) break;
			if (attempt < maxAttempts)
				await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
		}
		// Every attempt was cut: hand back the last partial stream, exactly what
		// the harness would have seen without the guard.
		const { response, drained } = last as NonNullable<typeof last>;
		return replay(response, drained.chunks, drained.error || undefined);
	};
}

let installed = false;

/** Wraps the process's global fetch once, so every model transport (including the Codex subscription's) goes through the guard. */
export function installTransportGuard(
	options: Parameters<typeof guardedFetch>[1] = {},
) {
	if (installed) return;
	installed = true;
	globalThis.fetch = guardedFetch(globalThis.fetch.bind(globalThis), options);
}
