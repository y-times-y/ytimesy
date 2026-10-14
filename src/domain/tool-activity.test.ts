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
	expect(
		toolActivity(call("wait_for_sidekick", { seconds: 5 }, { status: "done" })),
	).toMatchObject({ verb: "Checked on sidekick", note: "done", glyph: "wait" });
	expect(toolActivity(call("take_control", { reason: "x" })).glyph).toBe(
		"takeover",
	);
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
