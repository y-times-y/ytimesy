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
			{ kind: "property", text: "title" },
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
			{ kind: "function", text: "add" },
			{ kind: "sign", text: "(" },
			{ kind: "identifier", text: "item" },
			{ kind: "sign", text: "):" },
		]);
		expect(tokenizeSourceLine("# done", "python")).toEqual([
			{ kind: "comment", text: "# done" },
		]);
	});

	it("splits numbers, properties, and CSS colors away from plain identifiers", () => {
		expect(tokenizeSourceLine("count = 12", "javascript")).toEqual([
			{ kind: "identifier", text: "count" },
			{ kind: "identifier", text: " " },
			{ kind: "sign", text: "=" },
			{ kind: "identifier", text: " " },
			{ kind: "number", text: "12" },
		]);
		expect(tokenizeSourceLine("color: #3b82f6;", "css")).toEqual([
			{ kind: "property", text: "color" },
			{ kind: "sign", text: ":" },
			{ kind: "identifier", text: " " },
			{ kind: "number", text: "#3b82f6" },
			{ kind: "sign", text: ";" },
		]);
		expect(tokenizeSourceLine("fn ready()", "rust")).toEqual([
			{ kind: "keyword", text: "fn" },
			{ kind: "identifier", text: " " },
			{ kind: "function", text: "ready" },
			{ kind: "sign", text: "()" },
		]);
		expect(tokenizeSourceLine("}, 120_000);", "javascript")).toEqual([
			{ kind: "sign", text: "}," },
			{ kind: "identifier", text: " " },
			{ kind: "number", text: "120_000" },
			{ kind: "sign", text: ");" },
		]);
		expect(
			tokenizeSourceLine("const timeout = setTimeout(", "javascript"),
		).toEqual([
			{ kind: "keyword", text: "const" },
			{ kind: "identifier", text: " " },
			{ kind: "identifier", text: "timeout" },
			{ kind: "identifier", text: " " },
			{ kind: "sign", text: "=" },
			{ kind: "identifier", text: " " },
			{ kind: "function", text: "setTimeout" },
			{ kind: "sign", text: "(" },
		]);
	});
});
