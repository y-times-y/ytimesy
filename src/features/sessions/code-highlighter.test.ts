import { describe, expect, it } from "vitest";
import { codeHighlighter } from "./code-highlighter";

describe("shared Shiki highlighter", () => {
	it("loads TypeScript grammar and preserves multiline source exactly", async () => {
		const source = "/* first\nsecond */\nconst name: string = '<script>';";
		const result = await new Promise<
			NonNullable<ReturnType<typeof codeHighlighter.highlight>>
		>((resolve) => {
			const ready = codeHighlighter.highlight(
				{
					code: source,
					language: "typescript",
					themes: codeHighlighter.getThemes(),
				},
				resolve,
			);
			if (ready) resolve(ready);
		});
		expect(
			result.tokens
				.map((line) => line.map((token) => token.content).join(""))
				.join("\n"),
		).toBe(source);
		expect(result.tokens[0][0].htmlStyle?.["--shiki-dark"]).toBe(
			result.tokens[1][0].htmlStyle?.["--shiki-dark"],
		);
		expect(result.tokens[2].length).toBeGreaterThan(3);
		// `const` is a storage type in Ember Dusk (sky blue), not GitHub Dark's red.
		expect(
			result.tokens[2]
				?.find((token) => token.content === "const")
				?.htmlStyle?.["--shiki-dark"]?.toLowerCase(),
		).toBe("#6cb6ff");
	});
});
