import { expect, it } from "vitest";
import type { DynamicToolCallItem } from "./session-item";
import { displayCommand, toolActivity } from "./tool-detail";

const call = (tool: string, input: unknown, output?: unknown) =>
	({
		id: "1",
		kind: "dynamicToolCall",
		tool,
		status: "completed",
		input: JSON.stringify(input),
		output: output === undefined ? undefined : JSON.stringify(output),
	}) as DynamicToolCallItem;

it("describes tool calls as short sentences with the right icon", () => {
	expect(
		toolActivity(
			call("execute_command", { command: "cd /app && make -C /app test" }),
		),
	).toMatchObject({ verb: "Ran", target: "make -C /app test", glyph: "test" });
	expect(
		toolActivity(
			call("execute_command", {
				command:
					"pwd && git status --short && printf '\\n--- a ---\\n' && cat a.txt && rg -n foo src",
			}),
		),
	).toMatchObject({ target: "cat a.txt · rg -n foo src", glyph: "read" });
	expect(
		displayCommand(
			"set -e\nPYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'\nprint(1)\nprint(2)\nPY",
		),
	).toBe("python3 script · 2 lines");
	expect(
		toolActivity(
			call("apply_patch", {
				operation: {
					type: "update_file",
					path: "src/a/lsm_db.h",
					diff: "@@\n-old\n+new\n+more\n keep",
				},
			}),
		),
	).toEqual({
		verb: "Edited",
		target: "lsm_db.h",
		code: true,
		added: 2,
		removed: 1,
	});
	expect(
		toolActivity(
			call("apply_patch", {
				operation: { type: "create_file", path: "tests/x.cc", diff: "+a" },
			}),
		),
	).toMatchObject({ verb: "Created", target: "x.cc" });
	expect(toolActivity(call("mcp__linear__list_issues", {}))).toMatchObject({
		verb: "linear",
		target: "list issues",
	});
	expect(
		toolActivity(call("view_image", { path: "out/shot.png" })),
	).toMatchObject({ verb: "Viewed", target: "shot.png", glyph: "image" });
	expect(toolActivity(call("some_new_tool", {})).verb).toBe("Some new tool");
});

it("describes provider-hosted web searches and page opens", () => {
	expect(
		toolActivity(
			call(
				"web_search",
				{},
				{
					action: {
						type: "search",
						query: "bun latest release",
						queries: ["bun latest release", "deno latest release"],
					},
				},
			),
		),
	).toMatchObject({
		verb: "Searched the web",
		target: "bun latest release",
		note: "2 queries",
		glyph: "search",
	});
	expect(
		toolActivity(
			call(
				"web_search",
				{},
				{ action: { type: "openPage", url: "https://bun.sh/blog" } },
			),
		),
	).toMatchObject({
		verb: "Opened",
		target: "https://bun.sh/blog",
		glyph: "search",
	});
	expect(
		toolActivity(call("web_search", { query: "vite 8 migration guide" })),
	).toMatchObject({
		verb: "Searched the web",
		target: "vite 8 migration guide",
	});
	// OpenRouter: known only from cited sources.
	expect(
		toolActivity(
			call(
				"web_search",
				{ sources: 2 },
				{
					sources: [
						{ url: "https://www.npmjs.com/package/zod" },
						{ url: "https://github.com/colinhacks/zod/releases" },
					],
				},
			),
		),
	).toMatchObject({ verb: "Searched the web", note: "2 sources" });
});

it("describes a freeform apply_patch whose input is raw patch text", () => {
	expect(
		toolActivity({
			id: "1",
			kind: "dynamicToolCall",
			tool: "apply_patch",
			status: "completed",
			input:
				"*** Begin Patch\n*** Add File: src/new.ts\n+export const a = 1;\n+export const b = 2;\n*** End Patch",
		} as DynamicToolCallItem),
	).toMatchObject({ verb: "Created", target: "new.ts", added: 2, removed: 0 });
});

it("describes the lean surfaces' tools with the existing card kinds", () => {
	for (const [tool, input] of [
		["exec_command", { cmd: "npm test" }],
		["Bash", { command: "npm test" }],
		["run_shell_command", { command: "npm test" }],
		["bash", { command: "npm test" }],
	] as const)
		expect(toolActivity(call(tool, input))).toMatchObject({
			verb: "Ran",
			target: "npm test",
			glyph: "test",
		});
	expect(
		toolActivity(call("write_stdin", { session_id: "x", chars: "" })),
	).toMatchObject({
		glyph: "wait",
	});
	expect(
		toolActivity(call("write_stdin", { session_id: "x", chars: "\u0003" })),
	).toMatchObject({ verb: "Stopped command", glyph: "stop" });
	expect(
		toolActivity(call("Read", { file_path: "/w/src/app.ts" })),
	).toMatchObject({
		verb: "Read",
		target: "app.ts",
	});
	expect(toolActivity(call("read", { path: "shot.png" }))).toMatchObject({
		verb: "Viewed",
		glyph: "image",
	});
	expect(
		toolActivity(
			call("Edit", {
				file_path: "/w/src/app.ts",
				old_string: "a\nb",
				new_string: "c",
			}),
		),
	).toMatchObject({ verb: "Edited", target: "app.ts", added: 1, removed: 2 });
	expect(
		toolActivity(
			call("edit", {
				path: "src/app.ts",
				edits: [
					{ old_string: "a", new_string: "b\nc" },
					{ old_string: "d", new_string: "e" },
				],
			}),
		),
	).toMatchObject({ verb: "Edited", added: 3, removed: 2 });
	expect(
		toolActivity(
			call("edit", {
				path: "src/app.ts",
				edits: [{ oldText: "a\nb", newText: "c" }],
			}),
		),
	).toMatchObject({ verb: "Edited", added: 1, removed: 2 });
	expect(
		toolActivity(
			call("replace", { file_path: "a.py", old_string: "x", new_string: "y" }),
		),
	).toMatchObject({ verb: "Edited", target: "a.py" });
	expect(
		toolActivity(call("Write", { file_path: "/w/new.md", content: "a\nb\n" })),
	).toMatchObject({ verb: "Wrote", target: "new.md", added: 2 });
	expect(
		toolActivity(call("write_file", { file_path: "/w/x.ts", content: "x\n" })),
	).toMatchObject({ verb: "Wrote", target: "x.ts", added: 1 });
	expect(toolActivity(call("Grep", { pattern: "TODO" }))).toMatchObject({
		verb: "Searched",
		glyph: "search",
	});
	expect(toolActivity(call("glob", { pattern: "**/*.ts" }))).toMatchObject({
		verb: "Found files",
		glyph: "search",
	});
});

it("gives each file of a multi-file patch its own verb", () => {
	expect(
		toolActivity({
			id: "1",
			kind: "dynamicToolCall",
			tool: "apply_patch",
			status: "completed",
			input:
				"*** Begin Patch\n*** Update File: pager.py\n@@\n-    return a\n+    return b\n*** Add File: serve.py\n+print('ok')\n*** Delete File: old.py\n*** End Patch",
		} as DynamicToolCallItem),
	).toMatchObject({
		verb: "Edited",
		target: "pager.py",
		added: 2,
		removed: 1,
		note: "Created serve.py, Deleted old.py",
	});
});
