import { describe, expect, it } from "vitest";
import {
	changesReadMark,
	gitChangesPolling,
	RUNNING_TURN_CHANGES_POLL_MS,
} from "./git-changes-polling";

describe("the Diff panel's git read", () => {
	it("polls every 10 s while the chat's turn runs", () => {
		expect(gitChangesPolling("running")).toMatchObject({
			refetchInterval: RUNNING_TURN_CHANGES_POLL_MS,
		});
		expect(RUNNING_TURN_CHANGES_POLL_MS).toBe(10_000);
	});

	it("does not poll between turns, so the VM can pause; focus still reads", () => {
		for (const status of ["idle", "completed", "failed"] as const)
			expect(gitChangesPolling(status)).toEqual({
				refetchInterval: false,
				refetchIntervalInBackground: false,
				refetchOnWindowFocus: true,
			});
	});
});

describe("the Diff panel while the turn streams", () => {
	it("does not poll while the live stream is open, polls when it closes", () => {
		let open = true;
		const polling = gitChangesPolling("running", () => open);
		const interval = polling.refetchInterval as () => number | false;
		expect(interval()).toBe(false);
		open = false;
		expect(interval()).toBe(RUNNING_TURN_CHANGES_POLL_MS);
		const idle = gitChangesPolling("idle", () => false).refetchInterval as () =>
			| number
			| false;
		expect(idle()).toBe(false);
	});

	it("marks finished tool steps that may have changed files", () => {
		const id = "i" as never;
		expect(
			changesReadMark([
				{ kind: "fileChange", id, status: "completed", changes: [] },
				{
					kind: "commandExecution",
					id,
					command: "ls",
					cwd: null,
					status: "inProgress",
					output: null,
					exitCode: null,
				},
				{ kind: "dynamicToolCall", id, tool: "x", status: "failed" },
				{ kind: "agentMessage", id, text: "hi" } as never,
			]),
		).toBe(2);
	});
});
