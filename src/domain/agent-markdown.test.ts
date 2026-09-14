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
});
