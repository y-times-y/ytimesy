import type { HighlightResult } from "@streamdown/code";
import { codeHighlighter } from "./code-highlighter";
import type { HighlightReply, HighlightRequest } from "./highlight-off-thread";

/** Highlights code for highlight-off-thread.ts, away from the page's main thread. */
const scope = globalThis as unknown as {
	onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
	postMessage(message: HighlightReply): void;
};

scope.onmessage = ({ data: { id, code, language } }) => {
	let replied = false;
	const reply = (tokens: HighlightResult["tokens"] | null) => {
		if (replied) return;
		replied = true;
		scope.postMessage({ id, tokens });
	};
	try {
		const ready = codeHighlighter.highlight(
			{ code, language, themes: codeHighlighter.getThemes() },
			(result) => reply(result.tokens),
		);
		if (ready) reply(ready.tokens);
	} catch {
		reply(null);
	}
};
