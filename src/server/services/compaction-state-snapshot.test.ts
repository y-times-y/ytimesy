import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import type { WorkspaceId } from "#/domain/ids";
import {
	commandOutcomes,
	compactionStateSnapshot,
	formatStateSnapshot,
	gitStateCommand,
} from "./compaction-state-snapshot";
import type { WorkspaceMachines } from "./workspace-machines";

const call = (id: string, toolName: string, input: unknown): ModelMessage => ({
	role: "assistant",
	content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const result = (
	id: string,
	toolName: string,
	value: unknown,
): ModelMessage => ({
	role: "tool",
	content: [
		{
			type: "tool-result",
			toolCallId: id,
			toolName,
			output: { type: "json", value: value as never },
		},
	],
});
const commandId = "6f0d6e8e-2b5e-4c55-9d0f-6b9c7d2f1a01";
const runningId = "6f0d6e8e-2b5e-4c55-9d0f-6b9c7d2f1a02";
const transcript: ModelMessage[] = [
	{ role: "user", content: "Fix the tests" },
	call("1", "execute_command", { command: "pnpm vitest run" }),
	result("1", "execute_command", { id: commandId, status: "running" }),
	call("2", "continue_command", { id: commandId }),
	result("2", "continue_command", {
		id: commandId,
		status: 1,
		stdout: "1 failed",
	}),
	call("3", "execute_command", { command: "cat src/a.ts" }),
	result("3", "execute_command", { id: "x", status: 0 }),
	call("4", "execute_command", { command: "npx tsc --noEmit" }),
	result("4", "execute_command", { id: "y", status: 0 }),
	call("5", "execute_command", { command: "pnpm vitest run" }),
	result("5", "execute_command", { id: "z", status: 0 }),
	call("6", "start_command", { command: "pnpm build" }),
	result("6", "start_command", { id: runningId, status: "running" }),
	call("7", "bash", { command: "pnpm lint" }),
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "7",
				toolName: "bash",
				output: {
					type: "text",
					value: JSON.stringify({ exitCode: 2, stopped: "timeout" }),
				},
			},
		],
	},
];

it("reads check outcomes and running commands from tool results, not prose", () => {
	const outcomes = commandOutcomes(transcript);
	expect(outcomes.checks).toEqual([
		{ command: "npx tsc --noEmit", status: 0 },
		{ command: "pnpm vitest run", status: 0 },
		{ command: "pnpm lint", status: 2, stopped: "timeout" },
	]);
	expect(outcomes.running).toEqual([{ id: runningId, command: "pnpm build" }]);
});

it("formats a bounded, labelled snapshot", () => {
	const text = formatStateSnapshot({
		git: `M src/a.ts\n${"x".repeat(10_000)}`,
		outcomes: commandOutcomes(transcript),
	});
	expect(text.length).toBeLessThan(6_100);
	expect(text).toContain("## Changed files");
	expect(text).toContain("[git output truncated]");
	expect(text).toContain("- exit 2 (stopped: timeout): pnpm lint");
	expect(text).toContain(`- ${runningId}: pnpm build`);
	expect(
		formatStateSnapshot({ outcomes: { checks: [], running: [] } }),
	).toContain("Unavailable");
});

it("inspects git against the chat's start point and prefers authoritative running ids", async () => {
	const exec = vi.fn(async () => ({
		exitCode: 0,
		stdout: "git status --porcelain:\n M src/a.ts",
		stderr: "",
	}));
	const snapshot = compactionStateSnapshot({
		workspace: async () => ({
			machines: { exec } as unknown as WorkspaceMachines,
			vm: "vm" as WorkspaceId,
			cwd: "/workspace/repo",
		}),
		baseRef: async () => "refs/ytimesy/recovery/abc",
		runningIds: () => [],
	});
	const text = await snapshot(transcript, new AbortController().signal);
	expect(exec).toHaveBeenCalledWith(
		"vm",
		gitStateCommand("/workspace/repo", "refs/ytimesy/recovery/abc"),
		15_000,
	);
	expect(String(exec.mock.calls[0])).toContain("refs/ytimesy/recovery/abc");
	expect(text).toContain("M src/a.ts");
	expect(text).toContain("## Background commands still running");
	expect(text).not.toContain(runningId);
	const failing = compactionStateSnapshot({
		workspace: async () => {
			throw new Error("VM asleep");
		},
	});
	expect(await failing(transcript, new AbortController().signal)).toContain(
		"Unavailable",
	);
});

it("falls back to HEAD when no chat start point is recorded", () => {
	const command = gitStateCommand("/repo");
	expect(command).toContain("base=HEAD; label='HEAD'");
	expect(command).toContain("status --porcelain=v1 -uall");
	expect(command).toContain('diff --stat=160 "$base"');
});
