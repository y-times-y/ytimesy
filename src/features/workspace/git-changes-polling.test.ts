import { describe, expect, it } from "vitest";
import {
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
