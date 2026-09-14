import { describe, expect, it } from "vitest";
import { tokenizeSourceLine } from "./source-tokens";

describe("tokenizeSourceLine", () => {
	it("colors Codex-style TypeScript the way the desktop Diff does", () => {
		expect(
			tokenizeSourceLine(
				`export const hero = { title: "ytimesy" };`,
				"javascript",
			),
		).toEqual([
			{ kind: "keyword", text: "export" },
			{ kind: "identifier", text: " " },
			{ kind: "keyword", text: "const" },
			{ kind: "identifier", text: " " },
			{ kind: "identifier", text: "hero" },
			{ kind: "identifier", text: " " },
			{ kind: "sign", text: "=" },
			{ kind: "identifier", text: " " },
			{ kind: "sign", text: "{" },
			{ kind: "identifier", text: " " },
			{ kind: "identifier", text: "title" },
			{ kind: "sign", text: ":" },
			{ kind: "identifier", text: " " },
			{ kind: "string", text: '"ytimesy"' },
			{ kind: "identifier", text: " " },
			{ kind: "sign", text: "};" },
		]);
	});

	it("keeps Python def/class as keywords and # as a comment", () => {
		expect(tokenizeSourceLine("def add(item):", "python")).toEqual([
			{ kind: "keyword", text: "def" },
			{ kind: "identifier", text: " " },
			{ kind: "identifier", text: "add" },
			{ kind: "sign", text: "(" },
			{ kind: "identifier", text: "item" },
			{ kind: "sign", text: "):" },
		]);
		expect(tokenizeSourceLine("# done", "python")).toEqual([
			{ kind: "comment", text: "# done" },
		]);
	});
});
