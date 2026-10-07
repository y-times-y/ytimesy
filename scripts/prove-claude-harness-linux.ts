import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { apiAgentFileTools } from "../src/server/services/api-agent-file-tools";
import {
	scopedShellCommand,
	stopApiTurnCommands,
} from "../src/server/services/api-command-scope";
import { automaticRepositoryContext } from "../src/server/services/automatic-repository-context";
import {
	captureConversationCode,
	restoreConversationCode,
} from "../src/server/services/conversation-code-checkpoint";
import { harnessLifecycleHooks } from "../src/server/services/harness-lifecycle-hooks";
import { repositoryGuidanceTool } from "../src/server/services/repository-guidance";
import { localHarnessWorkspace } from "../tests/helpers/local-harness-workspace";

assert.equal(process.platform, "linux");
const fixture = await localHarnessWorkspace();
const turnId = randomUUID();
const checks: string[] = [];
try {
	const { root, workspace, run } = fixture;
	const signal = new AbortController().signal;
	await mkdir(join(root, "src"));
	await mkdir(join(root, ".ytimesy"));
	await writeFile(join(root, "AGENTS.md"), "Exact root instruction");
	await writeFile(join(root, "src/AGENTS.md"), "Exact nested instruction");
	await writeFile(join(root, "src/file.ts"), "export const value=1;\n");
	await writeFile(
		join(root, ".ytimesy/hooks.json"),
		JSON.stringify({
			version: 1,
			hooks: [
				{
					event: "PostToolUse",
					tool: "inspect",
					command: `printf x >> .hook-count; printf '{"message":"real Linux hook feedback"}'`,
				},
				{
					event: "PostToolUseFailure",
					tool: "reported_failure",
					command: `printf '{"message":"real failure hook feedback"}'`,
				},
				{
					event: "PostCompact",
					command: `printf '{"message":"real compact hook feedback"}'`,
				},
				{
					event: "Stop",
					command: `if test -f .hook-stop; then printf '{"continue":false}'; else touch .hook-stop; printf '{"continue":true,"message":"finish verification"}'; fi`,
				},
			],
		}),
	);
	await run("git", ["-C", root, "add", "."]);
	await run("git", ["-C", root, "commit", "-qm", "fixture baseline"]);
	const baseline = (
		await run("git", ["-C", root, "rev-parse", "HEAD"])
	).stdout.trim();
	const base: ToolSet = {
		...apiAgentFileTools({
			...workspace,
			readOnly: false,
			signal,
			once: (_id, run) => run(),
		}),
		read_repository_guidance: repositoryGuidanceTool({ ...workspace, signal }),
	};
	const context = automaticRepositoryContext({
		tools: base,
		workspace: async () => workspace,
		signal,
		onEvent: async () => {},
	});
	let messages: ModelMessage[] = await context.prepare([
		{ role: "user", content: "Edit nested file" },
	]);
	assert.match(JSON.stringify(messages), /Exact root instruction/);
	const options = {
		toolCallId: "edit",
		messages,
		abortSignal: signal,
		context: {},
	};
	const edit = context.tools.replace_text.execute;
	if (!edit) throw new Error("Missing edit tool");
	const deferred = await edit(
		{
			path: "src/file.ts",
			old: "export const value=1;",
			new: "export const value=2;",
		},
		options,
	);
	assert.equal((deferred as { retryRequired: boolean }).retryRequired, true);
	assert.match(await readFile(join(root, "src/file.ts"), "utf8"), /value=1/);
	messages = await context.afterTools(messages);
	assert.match(JSON.stringify(messages), /Exact nested instruction/);
	const read = context.tools.read_file.execute;
	if (!read) throw new Error("Missing reader");
	const result = await read(
		{ path: "src/file.ts" },
		{ ...options, toolCallId: "read", messages },
	);
	messages = await context.afterTools([
		...messages,
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "read",
					toolName: "read_file",
					output: { type: "json", value: JSON.parse(JSON.stringify(result)) },
				},
			],
		},
	]);
	await edit(
		{
			path: "src/file.ts",
			old: "export const value=1;",
			new: "export const value=2;",
		},
		{ ...options, toolCallId: "retry", messages },
	);
	messages = await context.prepare(messages);
	assert.match(JSON.stringify(messages), /Runtime source freshness notice/);
	assert.match(
		JSON.stringify(
			await context.restoreInstructions([
				{ role: "assistant", content: "Compacted" },
			]),
		),
		/Exact root instruction/,
	);
	checks.push(
		"real scoped instruction deferral, edit, stale-file notice, compaction reload",
	);
	const point = await captureConversationCode(workspace);
	await writeFile(join(root, "src/file.ts"), "later edit");
	const backup = await captureConversationCode(workspace);
	await restoreConversationCode(workspace, point, backup);
	assert.match(await readFile(join(root, "src/file.ts"), "utf8"), /value=2/);
	await restoreConversationCode(workspace, backup);
	assert.equal(await readFile(join(root, "src/file.ts"), "utf8"), "later edit");
	checks.push("real Git rewind and backup restoration");
	const journal = new Map<string, unknown>();
	const hooks = harnessLifecycleHooks({
		workspace: async () => workspace,
		turnId,
		readOnly: false,
		signal,
		baseline: async () => baseline,
		once: async (id, run) => {
			if (!journal.has(id)) journal.set(id, await run());
			return journal.get(id);
		},
		continuationCount: async () =>
			[...journal].filter(
				([id, result]) =>
					id.startsWith("lifecycle-stop-decision:") &&
					(result as { continue: boolean }).continue,
			).length,
	});
	const tools = hooks.wrap({
		reported_failure: tool({
			inputSchema: z.object({}),
			execute: async () => ({ status: "failed", output: "rejected patch" }),
		}),
		inspect: tool({
			inputSchema: z.object({}),
			execute: async () => ({ observed: true }),
		}),
	});
	const inspect = tools.inspect.execute;
	if (!inspect) throw new Error("Missing hook executor");
	await inspect({}, options);
	await inspect({}, options);
	assert.equal(await readFile(join(root, ".hook-count"), "utf8"), "x");
	assert.match(JSON.stringify(hooks.drain([])), /real Linux hook feedback/);
	const failed = await tools.reported_failure.execute?.({}, options);
	assert.deepEqual(failed, { status: "failed", output: "rejected patch" });
	assert.match(JSON.stringify(hooks.drain([])), /real failure hook feedback/);
	await hooks.postCompact(messages);
	assert.match(JSON.stringify(hooks.drain([])), /real compact hook feedback/);
	assert.equal(await hooks.stop([]), true);
	assert.equal(await hooks.stop(hooks.drain([])), false);
	checks.push(
		"real lifecycle hooks through Linux process fence and output capture, replay, Stop continuation",
	);
	const cancelled = workspace.machines.exec(
		workspace.vm,
		scopedShellCommand({
			turnId,
			cwd: root,
			command:
				"trap '' TERM; while true; do printf x >> ticks; sleep .05; done",
			seconds: 15,
		}),
		20000,
	);
	for (let i = 0; i < 100; i++) {
		if (await readFile(join(root, "ticks"), "utf8").catch(() => "")) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok((await readFile(join(root, "ticks"), "utf8")).length);
	await stopApiTurnCommands(workspace, turnId);
	await cancelled;
	const ticks = await readFile(join(root, "ticks"), "utf8");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(await readFile(join(root, "ticks"), "utf8"), ticks);
	const late = await workspace.machines.exec(
		workspace.vm,
		scopedShellCommand({
			turnId,
			cwd: root,
			command: "printf bad >> ticks",
			seconds: 1,
		}),
		3000,
	);
	assert.equal(late.exitCode, 130);
	checks.push("TERM-resistant process cancellation and late-start rejection");
	console.log(
		JSON.stringify(
			{ status: "passed", platform: process.platform, checks },
			null,
			2,
		),
	);
} finally {
	await stopApiTurnCommands(fixture.workspace, turnId);
	await fixture.cleanup();
}
