import type { HighlightResult } from "@streamdown/code";
import {
	diffHighlightSource,
	editDiffLines,
} from "#/domain/command-output-language";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { DEMO_EDIT } from "./landing-demo";

/** The preview's open edit: its diff lines, language and highlighted text. */
export const demoEditLines = editDiffLines(DEMO_EDIT.hunks);
export const demoEditLanguage = sourceLanguageFromPath(DEMO_EDIT.path);
export const demoEditSource = diffHighlightSource(demoEditLines);

/** Keeps only what HighlightedTokens draws, so the stored tokens stay small. */
export function compactTokens(tokens: HighlightResult["tokens"]) {
	return tokens.map((line) =>
		line.map((token) => {
			const style: Record<string, string> = {};
			for (const name of ["--shiki-dark", "--shiki-dark-font-style"]) {
				const value = token.htmlStyle?.[name];
				if (value && value !== "inherit") style[name] = value;
			}
			return { content: token.content, offset: token.offset, htmlStyle: style };
		}),
	);
}
