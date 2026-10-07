import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { automaticRepositoryContext } from "./automatic-repository-context";
import { batchedAgentReads } from "./batched-agent-reads";
import { repositoryGuidanceTool } from "./repository-guidance";

it("loads nested instructions, detects external changes once, and rehydrates exact root guidance after compaction", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const { workspace, root } = fixture;
		await mkdir(join(root, "src"));
		await writeFile(join(root, "AGENTS.md"), "Root requirement: use tests.");
		await writeFile(
			join(root, "src/AGENTS.md"),
			"Nested requirement: preserve the wire format.",
		);
		await writeFile(join(root, "src/file.ts"), "export const value = 1;\n");
		const signal = new AbortController().signal;
		const base: ToolSet = {
			...apiAgentFileTools({
				...workspace,
				readOnly: true,
				signal,
				once: (_id, run) => run(),
			}),
			read_repository_guidance: repositoryGuidanceTool({
				...workspace,
				signal,
			}),
		};
		const events = vi.fn(async () => {});
		const context = automaticRepositoryContext({
			tools: base,
			workspace: async () => workspace,
			signal,
			onEvent: events,
		});
		let history: ModelMessage[] = [
			{ role: "user", content: "Inspect src/file.ts" },
		];
		history = await context.prepare(history);
		const read = context.tools.read_file.execute;
		if (!read) throw new Error("Missing file reader");
		const output = await read(
			{ path: "src/file.ts" },
			{
				toolCallId: "read",
				messages: history,
				abortSignal: signal,
				context: {},
			},
		);
		history = await context.afterTools([
			...history,
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "read",
						toolName: "read_file",
						output: { type: "json", value: JSON.parse(JSON.stringify(output)) },
					},
				],
			},
		]);
		expect(JSON.stringify(history)).toContain("Nested requirement");
		expect(output).toMatchObject({
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		await writeFile(join(root, "src/file.ts"), "export const value = 2;\n");
		history = await context.prepare(history);
		expect(
			history.filter(
				(message) =>
					typeof message.content === "string" &&
					message.content.startsWith("Runtime source freshness notice"),
			),
		).toHaveLength(1);
		expect(await context.prepare(history)).toEqual(history);
		const restarted = automaticRepositoryContext({
			tools: base,
			workspace: async () => workspace,
			signal,
			onEvent: events,
		});
		expect(
			(await restarted.prepare(history)).filter(
				(message) =>
					typeof message.content === "string" &&
					message.content.startsWith("Runtime source freshness notice"),
			),
		).toHaveLength(1);
		const restored = await context.restoreInstructions([
			{
				role: "assistant",
				content: "A compacted summary without instructions",
			},
		]);
		expect(JSON.stringify(restored)).toContain("Root requirement: use tests.");
		expect(JSON.stringify(restored)).toContain("Runtime source read ledger");
		await writeFile(
			join(root, "AGENTS.md"),
			"Root requirement changed: use focused tests.",
		);
		expect(JSON.stringify(await context.prepare(restored))).toContain(
			"Root requirement changed",
		);
	} finally {
		await fixture.cleanup();
	}
});

it("does not inspect or rewrite repository state when no repository tools are available", async () => {
	const workspace = vi.fn();
	const context = automaticRepositoryContext({
		tools: {},
		workspace,
		signal: new AbortController().signal,
		onEvent: vi.fn(),
	});
	const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
	expect(await context.prepare(messages)).toBe(messages);
	expect(workspace).not.toHaveBeenCalled();
});

it("defers a scoped edit until the model has received new instructions, including nested patch operations", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "src"));
		await writeFile(
			join(fixture.root, "src/AGENTS.md"),
			"Scoped requirement: preserve public exports.",
		);
		const execute = vi.fn(async () => ({ written: true }));
		const signal = new AbortController().signal;
		const context = automaticRepositoryContext({
			workspace: async () => fixture.workspace,
			signal,
			onEvent: vi.fn(async () => {}),
			tools: {
				read_repository_guidance: repositoryGuidanceTool({
					...fixture.workspace,
					signal,
				}),
				apply_patch: tool({
					inputSchema: z.object({ operation: z.object({ path: z.string() }) }),
					execute,
				}),
			},
		});
		let history = await context.prepare([
			{ role: "user", content: "Edit src/file.ts" },
		]);
		const input = { operation: { path: "src/file.ts" } };
		const options = {
			toolCallId: "edit",
			messages: history,
			abortSignal: signal,
			context: {},
		};
		expect(
			await context.tools.apply_patch.execute?.(input, options),
		).toMatchObject({ retryRequired: true });
		expect(execute).not.toHaveBeenCalled();
		history = await context.afterTools(history);
		expect(JSON.stringify(history)).toContain("Scoped requirement");
		expect(
			await context.tools.apply_patch.execute?.(input, {
				...options,
				toolCallId: "retry",
				messages: history,
			}),
		).toEqual({ written: true });
		expect(execute).toHaveBeenCalledOnce();
	} finally {
		await fixture.cleanup();
	}
});

it("loads scoped guidance and retains freshness evidence from batched reads", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "src"));
		await writeFile(
			join(fixture.root, "src/AGENTS.md"),
			"Batch scope requirement",
		);
		await writeFile(join(fixture.root, "src/file.ts"), "first");
		const signal = new AbortController().signal;
		const base: ToolSet = {
			...apiAgentFileTools({
				...fixture.workspace,
				readOnly: true,
				signal,
				once: (_id, run) => run(),
			}),
			read_repository_guidance: repositoryGuidanceTool({
				...fixture.workspace,
				signal,
			}),
		};
		base.batch_read = batchedAgentReads(base, signal);
		const context = automaticRepositoryContext({
			tools: base,
			workspace: async () => fixture.workspace,
			signal,
			onEvent: vi.fn(async () => {}),
		});
		let history = await context.prepare([
			{ role: "user", content: "Inspect source" },
		]);
		const output = await context.tools.batch_read.execute?.(
			{
				reads: [
					{ tool: "read_files", arguments: { paths: ["src/file.ts"] } },
					{ tool: "read_files", arguments: { paths: ["source.txt"] } },
				],
			},
			{
				toolCallId: "batch",
				messages: history,
				abortSignal: signal,
				context: {},
			},
		);
		history = await context.afterTools([
			...history,
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolName: "batch_read",
						toolCallId: "batch",
						output: { type: "json", value: JSON.parse(JSON.stringify(output)) },
					},
				],
			},
		]);
		expect(JSON.stringify(history)).toContain("Batch scope requirement");
		await writeFile(join(fixture.root, "src/file.ts"), "changed externally");
		expect(JSON.stringify(await context.prepare(history))).toContain(
			"Runtime source freshness notice",
		);
	} finally {
		await fixture.cleanup();
	}
});
