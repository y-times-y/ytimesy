import { openai } from "@ai-sdk/openai";
import { jsonSchema, type ModelMessage, tool } from "ai";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	discoverableAgentTools,
	discoveredToolsFromSession,
} from "./agent-tool-discovery";

const definition = () =>
	tool({
		inputSchema: jsonSchema({ type: "object", properties: {} }),
		execute: async () => ({}),
	});

it("keeps ordinary edits/checks/review immediate but lazily loads uncommon workflow schemas without losing permission or discovery", () => {
	const tools = Object.fromEntries(
		[
			"start_command",
			"plan_parallel_work",
			"edit_task",
			"read_project_memory",
			"inspect_changes",
			"apply_patches",
			"run_checks",
			"inspect_task_diff",
			"read_task_output",
		].map((name) => [name, definition()]),
	);
	const lead = discoverableAgentTools(tools, [], [], "coordination");
	for (const name of [
		"start_command",
		"plan_parallel_work",
		"edit_task",
		"read_project_memory",
		"inspect_changes",
	]) {
		expect(lead[name].deferLoading).toBe(true);
		expect(lead[name].execute).toBe(tools[name].execute);
	}
	for (const name of ["inspect_task_diff", "read_task_output"])
		expect(lead[name].deferLoading).toBe(false);
	const builder = discoverableAgentTools(tools, [], [], "implementation");
	for (const name of ["inspect_changes", "apply_patches", "run_checks"])
		expect(builder[name].deferLoading).toBe(false);
	expect(
		discoverableAgentTools(tools, [], ["start_command"]).start_command
			.deferLoading,
	).toBe(false);
});

it("prefers the batch editor for new builders while preserving discovered aliases and providers without it", () => {
	const tools = {
		apply_patches: definition(),
		apply_patch: definition(),
		create_file: definition(),
		replace_text: definition(),
	};
	const builder = discoverableAgentTools(tools, [], [], "implementation");
	expect(builder.apply_patches.deferLoading).toBe(false);
	for (const name of ["apply_patch", "create_file", "replace_text"])
		expect(builder[name].deferLoading).toBe(true);
	expect(
		discoverableAgentTools(tools, [], ["replace_text"], "implementation")
			.replace_text.deferLoading,
	).toBe(false);
	expect(
		discoverableAgentTools(
			{ create_file: tools.create_file },
			[],
			[],
			"implementation",
		).create_file.deferLoading,
	).toBe(false);
	expect(builder.create_file.execute).toBe(tools.create_file.execute);
	const native = discoverableAgentTools(
		{
			apply_patches: definition(),
			apply_patch: openai.tools.applyPatch({}),
		},
		[],
		[],
		"implementation",
	);
	expect(native.apply_patch.deferLoading).toBe(false);
});

it("keeps common operations immediate and defers optional schemas without mutating permissions", () => {
	const tools = { read_file: definition(), browser_screenshot: definition() };
	const result = discoverableAgentTools(tools, []);
	expect(result.read_file.deferLoading).toBe(false);
	expect(result.browser_screenshot.deferLoading).toBe(true);
	expect(result.search_tools).toBeDefined();
	expect(result.create_file).toBeUndefined();
	expect(tools.browser_screenshot.deferLoading).toBeUndefined();
});

it("exposes required setup and review operations without a discovery round trip", () => {
	const names = [
		"read_environment_report",
		"inspect_task_diff",
		"mark_task_reviewed",
		"integrate_reviewed_tasks",
	];
	const tools = Object.fromEntries(names.map((name) => [name, definition()]));
	const result = discoverableAgentTools(tools, []);
	for (const name of names) expect(result[name].deferLoading).toBe(false);
	expect(
		discoverableAgentTools({ read_file: definition() }, []).mark_task_reviewed,
	).toBeUndefined();
});

it("restores search matches and earlier calls across durable single-step invocations", () => {
	const messages: ModelMessage[] = [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "search",
					toolName: "search_tools",
					output: {
						type: "json",
						value: {
							tools: [{ name: "browser_screenshot" }, { name: "forbidden" }],
						},
					},
				},
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "called",
					toolName: "publish_task",
					input: {},
				},
			],
		},
	];
	const result = discoverableAgentTools(
		{
			browser_screenshot: definition(),
			publish_task: definition(),
			browser_click: definition(),
		},
		messages,
	);
	expect(result.browser_screenshot.deferLoading).toBe(false);
	expect(result.publish_task.deferLoading).toBe(false);
	expect(result.browser_click.deferLoading).toBe(true);
	expect(result.forbidden).toBeUndefined();
});

it("does not create a tool surface for tool-free turns", () => {
	expect(discoverableAgentTools({}, [])).toEqual({});
});

it("defers unused builder coordination schemas without removing permissions or coding tools", () => {
	const tools = {
		read_file: definition(),
		create_task: definition(),
		read_task_output: definition(),
	};
	const builder = discoverableAgentTools(tools, [], [], "implementation");
	expect(builder.read_file.deferLoading).toBe(false);
	expect(builder.create_task.deferLoading).toBe(true);
	expect(builder.read_task_output.deferLoading).toBe(true);
	expect(builder.create_task.execute).toBe(tools.create_task.execute);
	expect(builder.search_tools).toBeDefined();
	expect(discoverableAgentTools(tools, []).create_task.deferLoading).toBe(
		false,
	);
	expect(
		discoverableAgentTools(tools, [], ["create_task"], "implementation")
			.create_task.deferLoading,
	).toBe(false);
	expect(tools.create_task.deferLoading).toBeUndefined();
});

it("retains discovery through compaction via durable tool receipts, without granting absent capabilities", () => {
	const known = discoveredToolsFromSession([
		{
			kind: "dynamicToolCall",
			id: SessionItemId("search"),
			tool: "search_tools",
			input: "{}",
			output: JSON.stringify({
				type: "json",
				value: {
					tools: [{ name: "browser_screenshot" }, { name: "create_file" }],
				},
			}),
			status: "completed",
		},
	]);
	const compacted: ModelMessage[] = [
		{ role: "user", content: "Earlier history compacted" },
	];
	const resumed = discoverableAgentTools(
		{ browser_screenshot: definition() },
		compacted,
		known,
	);
	expect(resumed.browser_screenshot.deferLoading).toBe(false);
	expect(resumed.create_file).toBeUndefined();
});
