import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelMessage, tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import { harnessLifecycleHooks } from "./harness-lifecycle-hooks";

// Exercise real shell commands/artifact capture on macOS; the Linux process
// fence itself is covered separately by api-command-scope tests.
vi.mock("./api-command-scope", () => ({
	scopedShellCommand: ({ command }: { command: string }) => command,
}));

it("pins config to baseline, replays hooks once, and bounds Stop continuation", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, ".ytimesy"));
		await writeFile(
			join(fixture.root, ".ytimesy/hooks.json"),
			JSON.stringify({
				version: 1,
				hooks: [
					{
						event: "PostToolUse",
						tool: "read_file",
						command: `printf '{"message":"run focused tests"}'; printf x >> ${fixture.root}/hook-count`,
					},
					{
						event: "Stop",
						command: `printf '{"continue":true,"message":"finish verification"}'`,
					},
				],
			}),
		);
		await fixture.run("git", ["-C", fixture.root, "add", "."]);
		await fixture.run("git", ["-C", fixture.root, "commit", "-qm", "hooks"]);
		const baseline = (
			await fixture.run("git", ["-C", fixture.root, "rev-parse", "HEAD"])
		).stdout.trim();
		await writeFile(
			join(fixture.root, ".ytimesy/hooks.json"),
			"invalid live edits are not trusted",
		);
		const saved = new Map<string, unknown>();
		const hooks = harnessLifecycleHooks({
			workspace: async () => fixture.workspace,
			turnId: randomUUID(),
			readOnly: false,
			signal: new AbortController().signal,
			baseline: async () => baseline,
			continuationCount: async () =>
				[...saved].filter(
					([id, result]) =>
						id.startsWith("lifecycle-stop-decision:") &&
						(result as { continue: boolean }).continue,
				).length,
			once: async (id, run) => {
				if (!saved.has(id)) saved.set(id, await run());
				return saved.get(id);
			},
		});
		const execute = hooks.wrap({
			read_file: tool({
				inputSchema: z.object({}),
				execute: async () => ({ content: "source" }),
			}),
		}).read_file.execute;
		if (!execute) throw new Error("Missing executor");
		const options = {
			toolCallId: "read",
			messages: [],
			abortSignal: new AbortController().signal,
			context: {},
		};
		await execute({}, options);
		await execute({}, options);
		expect(saved.size).toBe(1);
		expect(JSON.stringify(hooks.drain([]))).toContain("run focused tests");
		let messages: ModelMessage[] = [];
		for (let i = 0; i < 3; i++) {
			expect(await hooks.stop(messages)).toBe(true);
			messages = hooks.drain(messages);
		}
		// The durable journal still bounds continuation after history compaction.
		await expect(hooks.stop([])).rejects.toThrow("three continuations");
	} finally {
		await fixture.cleanup();
	}
});

it("preserves successful tool output and the original error when post hooks fail", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, ".ytimesy"));
		await writeFile(
			join(fixture.root, ".ytimesy/hooks.json"),
			JSON.stringify({
				version: 1,
				hooks: [
					{ event: "PostToolUse", command: "exit 9" },
					{ event: "PostToolUseFailure", command: "exit 8" },
				],
			}),
		);
		await fixture.run("git", ["-C", fixture.root, "add", "."]);
		await fixture.run("git", ["-C", fixture.root, "commit", "-qm", "hooks"]);
		const baseline = (
			await fixture.run("git", ["-C", fixture.root, "rev-parse", "HEAD"])
		).stdout.trim();
		const hooks = harnessLifecycleHooks({
			workspace: async () => fixture.workspace,
			turnId: randomUUID(),
			readOnly: false,
			signal: new AbortController().signal,
			baseline: async () => baseline,
			once: (_id, run) => run(),
		});
		const tools = hooks.wrap({
			success: tool({
				inputSchema: z.object({}),
				execute: async () => ({ done: true }),
			}),
			failure: tool({
				inputSchema: z.object({}),
				execute: async (): Promise<unknown> => {
					throw new Error("original error");
				},
			}),
		});
		const options = {
			toolCallId: "call",
			messages: [],
			abortSignal: new AbortController().signal,
			context: {},
		};
		expect(await tools.success.execute?.({}, options)).toEqual({ done: true });
		await expect(tools.failure.execute?.({}, options)).rejects.toThrow(
			"original error",
		);
		expect(JSON.stringify(hooks.drain([]))).toContain(
			"PostToolUse hook failed",
		);
	} finally {
		await fixture.cleanup();
	}
});

it("does not provision a VM or execute hooks for a read-only task", async () => {
	const workspace = vi.fn();
	const hooks = harnessLifecycleHooks({
		workspace,
		turnId: randomUUID(),
		readOnly: true,
		signal: new AbortController().signal,
		baseline: vi.fn(),
		once: vi.fn(),
	});
	expect(await hooks.stop([])).toBe(false);
	expect(workspace).not.toHaveBeenCalled();
});

it("dispatches failure hooks for returned patch/command failure receipts while preserving their contents", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		await mkdir(join(fixture.root, ".ytimesy"));
		await writeFile(
			join(fixture.root, ".ytimesy/hooks.json"),
			JSON.stringify({
				version: 1,
				hooks: [
					{
						event: "PostToolUse",
						command: `printf '{"message":"success event"}'`,
					},
					{
						event: "PostToolUseFailure",
						command: `printf '{"message":"failure event"}'`,
					},
				],
			}),
		);
		await fixture.run("git", ["-C", fixture.root, "add", "."]);
		await fixture.run("git", ["-C", fixture.root, "commit", "-qm", "hooks"]);
		const baseline = (
			await fixture.run("git", ["-C", fixture.root, "rev-parse", "HEAD"])
		).stdout.trim();
		const hooks = harnessLifecycleHooks({
			workspace: async () => fixture.workspace,
			turnId: randomUUID(),
			readOnly: false,
			signal: new AbortController().signal,
			baseline: async () => baseline,
			once: (_id, run) => run(),
		});
		for (const [index, receipt] of [
			{ status: "failed", output: "patch rejected" },
			{ exitCode: 1, stdout: "check failed" },
			{ ok: false, error: "unavailable" },
		].entries()) {
			const wrapped = hooks.wrap({
				operation: tool({
					inputSchema: z.object({}),
					execute: async () => receipt,
				}),
			});
			expect(
				await wrapped.operation.execute?.(
					{},
					{
						toolCallId: String(index),
						messages: [],
						context: {},
						abortSignal: new AbortController().signal,
					},
				),
			).toEqual(receipt);
			const feedback = JSON.stringify(hooks.drain([]));
			expect(feedback).toContain("failure event");
			expect(feedback).not.toContain("success event");
		}
	} finally {
		await fixture.cleanup();
	}
});

async function hooksFrom(config: unknown) {
	const fixture = await localHarnessWorkspace();
	await mkdir(join(fixture.root, ".ytimesy"));
	await writeFile(
		join(fixture.root, ".ytimesy/hooks.json"),
		JSON.stringify(config),
	);
	await fixture.run("git", ["-C", fixture.root, "add", "."]);
	await fixture.run("git", ["-C", fixture.root, "commit", "-qm", "hooks"]);
	const baseline = (
		await fixture.run("git", ["-C", fixture.root, "rev-parse", "HEAD"])
	).stdout.trim();
	const hooks = harnessLifecycleHooks({
		workspace: async () => fixture.workspace,
		turnId: randomUUID(),
		readOnly: false,
		signal: new AbortController().signal,
		baseline: async () => baseline,
		once: (_id, run) => run(),
	});
	return { fixture, hooks };
}
const callOptions = (toolCallId: string) => ({
	toolCallId,
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
});

it("lets PreToolUse refuse a call before it runs, and fails closed when the hook breaks", async () => {
	const { fixture, hooks } = await hooksFrom({
		version: 1,
		hooks: [
			{
				event: "PreToolUse",
				tool: "execute_command",
				command: `case "$YTIMESY_HOOK_INPUT" in *"rm -rf"*) printf '{"block":true,"message":"destructive command"}';; *) printf '{"message":"allowed by policy"}';; esac`,
			},
			{ event: "PreToolUse", tool: "broken_tool", command: "exit 3" },
		],
	});
	try {
		const ran: string[] = [];
		const tools = hooks.wrap({
			execute_command: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: async ({ command }) => {
					ran.push(command);
					return { status: 0 };
				},
			}),
			broken_tool: tool({
				inputSchema: z.object({}),
				execute: async () => {
					ran.push("broken");
					return {};
				},
			}),
			unguarded: tool({
				inputSchema: z.object({}),
				execute: async () => ({ ok: true }),
			}),
		});
		expect(
			await tools.execute_command.execute?.(
				{ command: "rm -rf /data" },
				callOptions("a"),
			),
		).toEqual({
			blocked: true,
			error: "Blocked by a repository PreToolUse hook: destructive command",
		});
		expect(
			await tools.execute_command.execute?.(
				{ command: "ls" },
				callOptions("b"),
			),
		).toEqual({ status: 0 });
		expect(JSON.stringify(hooks.drain([]))).toContain("allowed by policy");
		const broken = (await tools.broken_tool.execute?.(
			{},
			callOptions("c"),
		)) as { blocked: boolean; error: string };
		expect(broken.blocked).toBe(true);
		expect(broken.error).toContain("hook failed");
		expect(await tools.unguarded.execute?.({}, callOptions("d"))).toEqual({
			ok: true,
		});
		expect(ran).toEqual(["ls"]);
	} finally {
		await fixture.cleanup();
	}
});

it("lets UserPromptSubmit refuse a turn or add context to it", async () => {
	const { fixture, hooks } = await hooksFrom({
		version: 1,
		hooks: [
			{
				event: "UserPromptSubmit",
				command: `case "$YTIMESY_HOOK_INPUT" in *deploy*) printf '{"block":true,"message":"deploys go through CI"}';; *) printf '{"message":"use pnpm, not npm"}';; esac`,
			},
		],
	});
	try {
		expect(await hooks.userPromptSubmit("deploy to production")).toEqual({
			block: true,
			reason: "deploys go through CI",
		});
		expect(await hooks.userPromptSubmit("fix the parser")).toEqual({
			block: false,
		});
		expect(JSON.stringify(hooks.drain([]))).toContain("use pnpm, not npm");
	} finally {
		await fixture.cleanup();
	}
});

it("reuses a baseline's configuration across durable steps through the config cache", async () => {
	const exec = vi.fn(async () => ({
		exitCode: 0,
		stdout: JSON.stringify({
			version: 1,
			hooks: [{ event: "PostCompact", command: "true" }],
		}),
		stderr: "",
	}));
	const cache = new Map<string, unknown>();
	const step = () =>
		harnessLifecycleHooks({
			workspace: async () =>
				({ machines: { exec }, vm: "vm", cwd: "/repo" }) as never,
			turnId: "turn",
			readOnly: false,
			signal: new AbortController().signal,
			baseline: async () => "a".repeat(40),
			once: async (_id, run) => run(),
			configCache: async (key, load) => {
				if (!cache.has(key)) cache.set(key, await load());
				return cache.get(key) as Awaited<ReturnType<typeof load>>;
			},
		});
	expect(await step().userPromptSubmit("first")).toEqual({ block: false });
	expect(await step().userPromptSubmit("second")).toEqual({ block: false });
	expect(exec).toHaveBeenCalledOnce();
	expect([...cache.keys()]).toEqual([
		`lifecycle-hooks:/repo:${"a".repeat(40)}`,
	]);
});

it("loads a baseline without configuration as no hooks in one guest call, and fails closed on an unknown baseline", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const baseline = (
			await fixture.run("git", ["-C", fixture.root, "rev-parse", "HEAD"])
		).stdout.trim();
		const exec = vi.spyOn(fixture.workspace.machines, "exec");
		const hooks = (base: string) =>
			harnessLifecycleHooks({
				workspace: async () => fixture.workspace,
				turnId: randomUUID(),
				readOnly: false,
				signal: new AbortController().signal,
				baseline: async () => base,
				once: async (_id, run) => run(),
			});
		expect(await hooks(baseline).userPromptSubmit("hi")).toEqual({
			block: false,
		});
		expect(exec).toHaveBeenCalledOnce();
		await expect(hooks("b".repeat(40)).userPromptSubmit("hi")).rejects.toThrow(
			"Could not load baseline lifecycle hooks.",
		);
	} finally {
		await fixture.cleanup();
	}
});
