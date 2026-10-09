import { createHash } from "node:crypto";
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

it("retains loaded nested guidance across durable model-step reconstruction", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "src"));
		await writeFile(
			join(fixture.root, "src/file.ts"),
			"export const value = 1;",
		);
		const signal = new AbortController().signal;
		const events = vi.fn(async () => {});
		const base = {
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
		const create = () =>
			automaticRepositoryContext({
				tools: base,
				workspace: async () => fixture.workspace,
				signal,
				onEvent: events,
			});
		const first = create();
		let history = await first.prepare([
			{ role: "user", content: "Inspect src/file.ts" },
		]);
		await first.tools.read_file.execute?.(
			{ path: "src/file.ts" },
			{
				toolCallId: "first",
				messages: history,
				abortSignal: signal,
				context: {},
			},
		);
		history = await first.afterTools(history);
		const before = events.mock.calls.length;
		const resumed = create();
		history = await resumed.prepare(history);
		await resumed.tools.read_file.execute?.(
			{ path: "src/file.ts" },
			{
				toolCallId: "second",
				messages: history,
				abortSignal: signal,
				context: {},
			},
		);
		expect(events.mock.calls.slice(before)).toEqual([]);
	} finally {
		await fixture.cleanup();
	}
});

it("does not trust failed or invalid guidance receipts as a loaded scope", async () => {
	for (const value of [
		{ error: "Failed" },
		{ scope: "../src", instructions: [] },
	]) {
		const execute = vi.fn().mockResolvedValue({ scope: ".", instructions: [] });
		const context = automaticRepositoryContext({
			tools: {
				read_repository_guidance: tool({
					inputSchema: z.object({ scope: z.string() }),
					execute,
				}),
			},
			workspace: vi.fn(),
			signal: new AbortController().signal,
			onEvent: async () => {},
		});
		await context.prepare([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "old",
						toolName: "read_repository_guidance",
						output: { type: "json", value },
					},
				],
			},
		]);
		expect(execute).toHaveBeenCalledOnce();
	}
});

it("refreshes changed nested instructions after reconstructing loaded scopes", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "src"));
		await writeFile(
			join(fixture.root, "src/AGENTS.md"),
			"Old nested requirement.",
		);
		const signal = new AbortController().signal;
		const create = () =>
			automaticRepositoryContext({
				tools: {
					read_repository_guidance: repositoryGuidanceTool({
						...fixture.workspace,
						signal,
					}),
				},
				workspace: async () => fixture.workspace,
				signal,
				onEvent: async () => {},
			});
		const first = create();
		const history = await first.prepare([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "nested",
						toolName: "read_repository_guidance",
						output: {
							type: "json",
							value: z.json().parse(
								await repositoryGuidanceTool({
									...fixture.workspace,
									signal,
								}).execute?.(
									{ scope: "src" },
									{
										toolCallId: "nested",
										messages: [],
										abortSignal: signal,
										context: {},
									},
								),
							),
						},
					},
				],
			},
		]);
		await writeFile(
			join(fixture.root, "src/AGENTS.md"),
			"New nested requirement.",
		);
		expect(JSON.stringify(await create().prepare(history))).toContain(
			"New nested requirement.",
		);
	} finally {
		await fixture.cleanup();
	}
});

it("reuses surviving complete guidance after compaction but reloads missing and changed bodies", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await writeFile(join(fixture.root, "AGENTS.md"), "Always verify changes.");
		await writeFile(join(fixture.root, "package.json"), '{"name":"fixture"}');
		const signal = new AbortController().signal;
		const context = automaticRepositoryContext({
			tools: {
				read_repository_guidance: repositoryGuidanceTool({
					...fixture.workspace,
					signal,
				}),
			},
			workspace: async () => fixture.workspace,
			signal,
			onEvent: vi.fn(async () => {}),
		});
		const history = await context.prepare([
			{ role: "user", content: "Review" },
		]);
		const restored = await context.restoreInstructions(history);
		const original = JSON.stringify(history);
		const appended = JSON.stringify(restored.slice(history.length));
		expect(original).toContain("Always verify changes.");
		expect(appended).not.toContain("Always verify changes.");
		expect(appended).not.toContain('\\"name\\":\\"fixture\\"');
		expect(appended).toContain("alreadyInContext");
		expect(appended).toContain('"scopeFilesAlreadyInContext":true');
		expect(appended).toContain('"scopeFiles":[]');
		const missing = await context.restoreInstructions([
			{ role: "assistant", content: "Summary" },
		]);
		expect(JSON.stringify(missing)).toContain("Always verify changes.");
		expect(JSON.stringify(missing)).toContain(
			'"scopeFiles":["AGENTS.md","package.json","source.txt"]',
		);
		await writeFile(
			join(fixture.root, "new-file.ts"),
			"export const fresh = true;",
		);
		const changedInventory = await context.restoreInstructions(history);
		expect(JSON.stringify(changedInventory.slice(history.length))).toContain(
			"new-file.ts",
		);
		await writeFile(
			join(fixture.root, "AGENTS.md"),
			"New requirement: test boundaries.",
		);
		expect(
			JSON.stringify(await context.restoreInstructions(history)),
		).toContain("New requirement: test boundaries.");
	} finally {
		await fixture.cleanup();
	}
});

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

it("retains freshness evidence from structured code reads", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "src"));
		const source = "export const value = 1;\n";
		await writeFile(join(fixture.root, "src/file.ts"), source);
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
				read_code: tool({
					inputSchema: z.object({
						files: z.array(z.object({ path: z.string() })),
					}),
					execute: async () => ({
						files: [
							{
								path: "src/file.ts",
								sha256: createHash("sha256").update(source).digest("hex"),
							},
						],
					}),
				}),
			},
		});
		let history = await context.prepare([
			{ role: "user", content: "Inspect source" },
		]);
		const output = await context.tools.read_code.execute?.(
			{ files: [{ path: "src/file.ts" }] },
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
						toolName: "read_code",
						output: { type: "json", value: JSON.parse(JSON.stringify(output)) },
					},
				],
			},
		]);
		await writeFile(
			join(fixture.root, "src/file.ts"),
			"export const value = 2;\n",
		);
		history = await context.prepare(history);
		expect(
			history.filter(
				(message) =>
					typeof message.content === "string" &&
					message.content.startsWith("Runtime source freshness notice"),
			),
		).toHaveLength(1);
		expect(await context.prepare(history)).toEqual(history);
	} finally {
		await fixture.cleanup();
	}
});

it("delivers rename destination instructions before allowing the move", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, "destination"));
		await writeFile(
			join(fixture.root, "destination/AGENTS.md"),
			"Destination requirement: preserve exports.",
		);
		const signal = new AbortController().signal;
		const execute = vi.fn(async () => ({ moved: true }));
		const context = automaticRepositoryContext({
			workspace: async () => fixture.workspace,
			signal,
			onEvent: vi.fn(async () => {}),
			tools: {
				read_repository_guidance: repositoryGuidanceTool({
					...fixture.workspace,
					signal,
				}),
				rename_file: tool({
					inputSchema: z.object({ path: z.string(), newPath: z.string() }),
					execute,
				}),
			},
		});
		let history = await context.prepare([
			{ role: "user", content: "Move the file" },
		]);
		const input = { path: "file.ts", newPath: "destination/file.ts" };
		const options = {
			toolCallId: "move",
			messages: history,
			abortSignal: signal,
			context: {},
		};
		expect(
			await context.tools.rename_file.execute?.(input, options),
		).toMatchObject({ retryRequired: true });
		expect(execute).not.toHaveBeenCalled();
		history = await context.afterTools(history);
		expect(JSON.stringify(history)).toContain("Destination requirement");
		expect(
			await context.tools.rename_file.execute?.(input, {
				...options,
				messages: history,
			}),
		).toEqual({ moved: true });
		expect(execute).toHaveBeenCalledOnce();
	} finally {
		await fixture.cleanup();
	}
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
