import type { HighlightResult } from "@streamdown/code";
import { useEffect, useState } from "react";
import type { SourceLanguage } from "#/domain/source-language";
import { highlightCode } from "./highlight-off-thread";

type Tokens = HighlightResult["tokens"];

/** Tokens known before the page runs (the front page's preview), by language and text. */
const primed = new Map<string, Tokens>();
const primedKey = (text: string, language: SourceLanguage) =>
	`${language}\u0000${text}`;

/**
 * Lets code whose colours were worked out ahead of time paint coloured on
 * the server render and the first client paint, instead of plain and then
 * coloured once the highlighter has run.
 */
export function primeHighlightedLines(
	text: string,
	language: SourceLanguage,
	tokens: Tokens,
) {
	primed.set(primedKey(text, language), tokens);
}

export function useHighlightedLines(text: string, language: SourceLanguage) {
	const ready = primed.get(primedKey(text, language));
	const [result, setResult] = useState<{
		text: string;
		language: SourceLanguage;
		tokens: Tokens;
	}>();
	useEffect(() => {
		if (language === "text" || ready) return;
		return highlightCode(text, language, (tokens) =>
			setResult({ text, language, tokens }),
		);
	}, [text, language, ready]);
	if (ready) return ready;
	return result?.text === text && result.language === language
		? result.tokens
		: undefined;
}

export function HighlightedTokens({
	text,
	tokens,
}: {
	text: string;
	tokens?: HighlightResult["tokens"][number];
}) {
	return tokens
		? tokens.map((token) => (
				<span
					key={token.offset}
					style={{
						color: token.htmlStyle?.["--shiki-dark"] ?? token.color,
						// With two themes, Shiki passes the dark theme's italics as a variable.
						fontStyle:
							token.htmlStyle?.["--shiki-dark-font-style"] === "italic" ||
							(token.fontStyle && token.fontStyle & 1)
								? "italic"
								: undefined,
						fontWeight:
							token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
						textDecoration:
							token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
					}}
				>
					{token.content}
				</span>
			))
		: text;
}
