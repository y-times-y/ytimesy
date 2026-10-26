import type { HighlightOptions, HighlightResult } from "@streamdown/code";
import { codeHighlighter } from "./code-highlighter";

export type HighlightRequest = {
	readonly id: number;
	readonly code: string;
	readonly language: HighlightOptions["language"];
};
export type HighlightReply = {
	readonly id: number;
	readonly tokens: HighlightResult["tokens"] | null;
};
type Tokens = HighlightResult["tokens"];

/**
 * Shiki tokenizes about 2 KB of source in a few milliseconds but a 400-line
 * file in about 180 ms (700 ms with a 4x slower CPU), freezing the page while
 * a big tool output, diff or file preview opens. Code this long is
 * highlighted in a Web Worker; shorter code stays on the main thread, where
 * it is ready a frame sooner.
 */
export const OFF_THREAD_MIN_CHARS = 2_000;

let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<
	number,
	HighlightRequest & { receive(t: Tokens): void }
>();

function highlightWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		worker = null;
		return worker;
	}
	worker.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
		const request = waiting.get(data.id);
		waiting.delete(data.id);
		if (request && data.tokens) request.receive(data.tokens);
	};
	// A worker that cannot start (blocked, failed chunk) hands its work back.
	worker.onerror = () => {
		worker?.terminate();
		worker = null;
		const pending = [...waiting.values()];
		waiting.clear();
		for (const request of pending)
			highlightOnMainThread(request.code, request.language, request.receive);
	};
	return worker;
}

function highlightOnMainThread(
	code: string,
	language: HighlightRequest["language"],
	receive: (tokens: Tokens) => void,
) {
	const ready = codeHighlighter.highlight(
		{ code, language, themes: codeHighlighter.getThemes() },
		(result) => receive(result.tokens),
	);
	if (ready) receive(ready.tokens);
}

/**
 * Highlights `code` and passes its tokens (one array per line) to `receive`,
 * off the main thread when the code is long. Returns a cancel function.
 */
export function highlightCode(
	code: string,
	language: HighlightRequest["language"],
	receive: (tokens: Tokens) => void,
): () => void {
	let cancelled = false;
	const deliver = (tokens: Tokens) => {
		if (!cancelled) receive(tokens);
	};
	const target =
		code.length >= OFF_THREAD_MIN_CHARS && typeof Worker !== "undefined"
			? highlightWorker()
			: null;
	if (!target) {
		highlightOnMainThread(code, language, deliver);
		return () => {
			cancelled = true;
		};
	}
	const id = nextId++;
	waiting.set(id, { id, code, language, receive: deliver });
	target.postMessage({ id, code, language } satisfies HighlightRequest);
	return () => {
		cancelled = true;
		waiting.delete(id);
	};
}
