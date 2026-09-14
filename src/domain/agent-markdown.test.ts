import { describe, expect, it } from "vitest";
import { parseAgentMarkdown } from "./agent-markdown";

describe("parseAgentMarkdown", () => {
	it("turns Codex-style lists, code, and links into blocks instead of raw markup", () => {
		expect(
			parseAgentMarkdown(
				"Created these files:\n\n- [`todo.py`](/home/ubuntu/todo-cli/todo.py)\n- **done**\n\nRun `python3 test_todo.py`.",
			),
		).toEqual([
			{
				kind: "paragraph",
				inlines: [{ kind: "text", text: "Created these files:" }],
			},
			{
				kind: "list",
				ordered: false,
				items: [
					[{ kind: "code", text: "todo.py" }],
					[{ kind: "strong", text: "done" }],
				],
			},
			{
				kind: "paragraph",
				inlines: [
					{ kind: "text", text: "Run " },
					{ kind: "code", text: "python3 test_todo.py" },
					{ kind: "text", text: "." },
				],
			},
		]);
	});

	it("keeps a lead-in and numbered list on adjacent lines", () => {
		expect(
			parseAgentMarkdown("Created:\n1. [`src/hero.tsx`](/tmp/src/hero.tsx)"),
		).toEqual([
			{
				kind: "paragraph",
				inlines: [{ kind: "text", text: "Created:" }],
			},
			{
				kind: "list",
				ordered: true,
				items: [[{ kind: "code", text: "src/hero.tsx" }]],
			},
		]);
	});

	it("keeps a fence language so agent snippets can be color-coded", () => {
		expect(
			parseAgentMarkdown(
				"```tsx\nexport const hero = { title: 'ytimesy' };\n```",
			),
		).toEqual([
			{
				kind: "code",
				language: "tsx",
				text: "export const hero = { title: 'ytimesy' };",
			},
		]);
	});

	it("keeps markdown file links from leaking raw brackets in a paragraph", () => {
		expect(
			parseAgentMarkdown("Created [`src/hero.tsx`](/tmp/src/hero.tsx) with:"),
		).toEqual([
			{
				kind: "paragraph",
				inlines: [
					{ kind: "text", text: "Created " },
					{ kind: "code", text: "src/hero.tsx" },
					{ kind: "text", text: " with:" },
				],
			},
		]);
		expect(
			parseAgentMarkdown("Created `[src/hero.tsx](/tmp/src/hero.tsx)` with:"),
		).toEqual([
			{
				kind: "paragraph",
				inlines: [
					{ kind: "text", text: "Created " },
					{ kind: "code", text: "src/hero.tsx" },
					{ kind: "text", text: " with:" },
				],
			},
		]);
	});
});
