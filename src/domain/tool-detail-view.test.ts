import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { DynamicToolCallItem } from "./session-item";
import { toolDetailView } from "./tool-detail-view";

const call = (
	tool: string,
	input: object,
	output?: string,
	status: DynamicToolCallItem["status"] = "completed",
): DynamicToolCallItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId("t"),
	tool,
	input: JSON.stringify(input),
	output,
	status,
});

describe("toolDetailView", () => {
	it("splits a stored command's output from its exit line", () => {
		expect(
			toolDetailView(call("bash", { command: "pnpm test" }, "FAIL a\nexit 1")),
		).toEqual({
			kind: "command",
			command: "pnpm test",
			output: "FAIL a",
			exit: 1,
			note: undefined,
		});
	});

	it("reads run_code's {output, exitCode} and a lean result object", () => {
		expect(
			toolDetailView(
				call(
					"bash",
					{ command: "ls" },
					JSON.stringify({ output: "a.ts", exitCode: 0 }),
				),
			),
		).toMatchObject({ output: "a.ts", exit: 0 });
		expect(
			toolDetailView(
				call(
					"bash",
					{ command: "sleep 9" },
					JSON.stringify({
						output: "",
						status: 124,
						stopped: "timeout",
						outputPath: "/tmp/x",
					}),
				),
			),
		).toMatchObject({ output: "", exit: "timeout" });
	});

	it("shows a failed command's error as its note", () => {
		expect(
			toolDetailView(call("bash", { command: "x" }, "VM is gone", "failed")),
		).toMatchObject({ exit: null, output: "", note: "VM is gone" });
	});

	it("numbers a read from its offset and keeps the file length out of the text", () => {
		expect(
			toolDetailView(
				call(
					"read",
					{ path: "src/a.ts", offset: 5 },
					"e\nf\n\n[Lines 5-6 of 12; read on from offset 7.]",
				),
			),
		).toEqual({
			kind: "read",
			path: "src/a.ts",
			startLine: 5,
			lines: ["e", "f"],
			totalLines: 12,
			note: undefined,
		});
	});

	it("takes a Claude-shaped read's own line numbers", () => {
		expect(
			toolDetailView(
				call("Read", { file_path: "a.py" }, "    10\tdef f():\n    11\t  pass"),
			),
		).toMatchObject({ startLine: 10, lines: ["def f():", "  pass"] });
	});

	it("turns an edit's swaps into hunks, legacy oldText/newText included", () => {
		expect(
			toolDetailView(
				call(
					"edit",
					{
						path: "a.ts",
						edits: [{ old_string: "a - b", new_string: "a + b" }],
					},
					"Updated a.ts: 1 edit applied.",
				),
			),
		).toMatchObject({
			kind: "edit",
			hunks: [{ removed: "a - b", added: "a + b" }],
		});
		expect(
			toolDetailView(
				call("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
			),
		).toMatchObject({ hunks: [{ removed: "x", added: "y" }] });
	});

	it("shows a written file's content and falls back to fields for other tools", () => {
		expect(
			toolDetailView(
				call(
					"write",
					{ path: "n.ts", content: "a\n" },
					"Created n.ts (1 lines).",
				),
			),
		).toMatchObject({ kind: "write", content: "a\n" });
		expect(
			toolDetailView(call("mcp__linear__get_issue", { id: "X-1" }, "{}")),
		).toMatchObject({ kind: "fields" });
	});
});
