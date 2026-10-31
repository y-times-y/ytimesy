import type { HighlightResult } from "@streamdown/code";
import { expect, it } from "vitest";
import { codeHighlighter } from "../sessions/code-highlighter";
import {
	compactTokens,
	demoEditLanguage,
	demoEditSource,
} from "./landing-diff-tokens";
import { demoEditTokens } from "./landing-diff-tokens.gen";

it("stores the preview diff's colours as the app's highlighter draws them", async () => {
	const result = await new Promise<HighlightResult>((resolve) => {
		const ready = codeHighlighter.highlight(
			{
				code: demoEditSource,
				language: demoEditLanguage as never,
				themes: codeHighlighter.getThemes(),
			},
			resolve,
		);
		if (ready) resolve(ready);
	});
	// Stale after a theme or DEMO_EDIT change: node --import tsx scripts/landing-diff-tokens.ts
	expect(compactTokens(result.tokens)).toEqual(demoEditTokens);
});
