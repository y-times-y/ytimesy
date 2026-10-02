import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { injectApiPeerMessages, stagePeerMessage } from "./peer-inbox";
import type { WorkspaceMachines } from "./workspace-machines";

it("Claude hooks inject each message once, including a pending message at Stop", () => {
	const root = mkdtempSync(join(tmpdir(), "ytimesy-peer-hook-"));
	try {
		writeFileSync(
			join(root, "one.json"),
			JSON.stringify({ id: "one", text: "Own schema.ts" }),
		);
		const hook = (event: string) =>
			execFileSync(
				"python3",
				["src/server/adapters/peer-inbox.py", root, "hook"],
				{
					input: JSON.stringify({ hook_event_name: event }),
					encoding: "utf8",
				},
			);
		expect(JSON.parse(hook("PostToolUse"))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: "Own schema.ts",
			},
		});
		expect(readFileSync(join(root, "one.json.accepted"), "utf8")).toBe(
			"accepted\n",
		);
		expect(hook("PostToolUse")).toBe("");
		writeFileSync(
			join(root, "two.json"),
			JSON.stringify({ id: "two", text: "Review finding" }),
		);
		expect(JSON.parse(hook("Stop")).hookSpecificOutput.additionalContext).toBe(
			"Review finding",
		);
		expect(hook("Stop")).toBe("");
	} finally {
		rmSync(root, { recursive: true });
	}
});

it("API injection checkpoints history before acknowledgement and does not duplicate restored input", async () => {
	const exec = vi
		.fn()
		.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify([{ id: "one", text: "Finding" }]),
		})
		.mockResolvedValueOnce({ exitCode: 0, stdout: "" });
	const checkpoint = vi.fn(async () => {
		expect(exec).toHaveBeenCalledTimes(1);
	});
	const history = [{ role: "user" as const, content: "Finding" }];
	expect(
		await injectApiPeerMessages(
			{ exec } as unknown as WorkspaceMachines,
			WorkspaceId("vm"),
			history,
			checkpoint,
			"recipient",
		),
	).toEqual(history);
	expect(checkpoint).toHaveBeenCalledWith(history);
	expect(exec.mock.calls[1][1]).toContain(" ack 'one'");
});

it("a failed API checkpoint leaves the message unacknowledged", async () => {
	const exec = vi.fn().mockResolvedValue({
		exitCode: 0,
		stdout: '[{"id":"one","text":"Finding"}]',
	});
	await expect(
		injectApiPeerMessages(
			{ exec } as unknown as WorkspaceMachines,
			WorkspaceId("vm"),
			[],
			async () => {
				throw new Error("lease lost");
			},
			"recipient",
		),
	).rejects.toThrow("lease lost");
	expect(exec).toHaveBeenCalledTimes(1);
});

it("rejects mailbox path traversal before any machine operation", async () => {
	const exec = vi.fn();
	await expect(
		stagePeerMessage(
			{ exec } as unknown as WorkspaceMachines,
			WorkspaceId("vm"),
			"../other",
			"Finding",
			"recipient",
		),
	).rejects.toThrow("Invalid");
	expect(exec).not.toHaveBeenCalled();
});

it("ignores another session's pending messages inherited from a machine snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "ytimesy-peer-filter-"));
	try {
		writeFileSync(
			join(root, "parent.json"),
			JSON.stringify({
				id: "parent",
				recipientId: "parent",
				text: "Not for child",
			}),
		);
		writeFileSync(
			join(root, "child.json"),
			JSON.stringify({ id: "child", recipientId: "child", text: "For child" }),
		);
		const output = execFileSync(
			"python3",
			["src/server/adapters/peer-inbox.py", root, "peek", "child"],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(output)).toEqual([
			{ id: "child", recipientId: "child", text: "For child" },
		]);
	} finally {
		rmSync(root, { recursive: true });
	}
});
