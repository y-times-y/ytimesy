import type { HighlightResult } from "@streamdown/code";
import { useEffect, useState } from "react";
import type { SourceLanguage } from "#/domain/source-language";
import { highlightCode } from "./highlight-off-thread";

export function useHighlightedLines(text: string, language: SourceLanguage) {
	const [result, setResult] = useState<{
		text: string;
		language: SourceLanguage;
		tokens: HighlightResult["tokens"];
	}>();
	useEffect(() => {
		if (language === "text") return;
		return highlightCode(text, language, (tokens) =>
			setResult({ text, language, tokens }),
		);
	}, [text, language]);
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
						fontStyle:
							token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
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
