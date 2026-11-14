import { describe, expect, it } from "vitest";
import {
	HELPER_FORK_RELEASE_MINUTES,
	type HelperForkFacts,
	helperForkReleaseBlocker,
} from "./subagent";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

function facts(overrides: Partial<HelperForkFacts> = {}): HelperForkFacts {
	return {
		vmId: "vm-fork",
		role: "writer",
		taskPlacement: "fresh",
		fork: {
			vmId: "vm-fork",
			sourceVmId: "vm-parent",
			bootedAt: minutesAgo(60),
			patch: null,
			reportedAt: minutesAgo(11),
		},
		turnStatus: "completed",
		parentVmId: "vm-parent",
		activeTurn: false,
		pendingMessage: false,
		reportUndelivered: false,
		openBackgroundCommand: false,
		heldElsewhere: false,
		activeSidekick: false,
		...overrides,
	};
}
const fork = (fields: Partial<HelperForkFacts["fork"]>) => ({
	...facts().fork,
	...fields,
});

describe("helperForkReleaseBlocker", () => {
	it("releases a finished writer's own fork 10 minutes after its report", () => {
		expect(HELPER_FORK_RELEASE_MINUTES).toBe(10);
		expect(helperForkReleaseBlocker(facts(), NOW)).toBeNull();
		// Days later (the backlog) too.
		expect(
			helperForkReleaseBlocker(
				facts({ fork: fork({ reportedAt: minutesAgo(8 * 24 * 60) }) }),
				NOW,
			),
		).toBeNull();
	});

	it("keeps it while the writer is running, queued or messaged", () => {
		expect(
			helperForkReleaseBlocker(facts({ turnStatus: "running" }), NOW),
		).toBe("a turn is running or queued");
		expect(helperForkReleaseBlocker(facts({ activeTurn: true }), NOW)).toBe(
			"a turn is running or queued",
		);
		expect(helperForkReleaseBlocker(facts({ pendingMessage: true }), NOW)).toBe(
			"a message waits for it",
		);
	});

	it("keeps it until the report exists, is old enough and was delivered", () => {
		expect(
			helperForkReleaseBlocker(
				facts({ fork: fork({ reportedAt: undefined }) }),
				NOW,
			),
		).toBe("it has not reported");
		expect(
			helperForkReleaseBlocker(
				facts({ fork: fork({ reportedAt: minutesAgo(9) }) }),
				NOW,
			),
		).toBe("it finished too recently");
		expect(
			helperForkReleaseBlocker(facts({ reportUndelivered: true }), NOW),
		).toBe("its report is not delivered");
	});

	it("keeps it while its patch is not captured", () => {
		const { patch: _patch, ...noPatch } = facts().fork;
		expect(helperForkReleaseBlocker(facts({ fork: noPatch }), NOW)).toBe(
			"its patch was not captured",
		);
		expect(
			helperForkReleaseBlocker(
				facts({ fork: fork({ patchError: "the export failed" }) }),
				NOW,
			),
		).toBe("its patch was not captured");
	});

	it("keeps it while a background command runs", () => {
		expect(
			helperForkReleaseBlocker(facts({ openBackgroundCommand: true }), NOW),
		).toBe("a background command is running");
	});

	it("never releases a VM shared with the parent or held by another session", () => {
		for (const role of ["researcher", "reviewer", "checker"] as const)
			expect(
				helperForkReleaseBlocker(
					facts({ role, taskPlacement: "shared", vmId: "vm-parent" }),
					NOW,
				),
			).toBe("it shares its parent's machine");
		expect(
			helperForkReleaseBlocker(facts({ taskPlacement: "shared" }), NOW),
		).toBe("it shares its parent's machine");
		expect(
			helperForkReleaseBlocker(
				facts({
					parentVmId: "vm-fork",
					fork: fork({ releasingAt: minutesAgo(1) }),
				}),
				NOW,
			),
		).toBe("another session holds the machine");
		expect(helperForkReleaseBlocker(facts({ heldElsewhere: true }), NOW)).toBe(
			"another session holds the machine",
		);
	});

	it("keeps an active sidekick; finishes a claimed release; skips a released one", () => {
		expect(helperForkReleaseBlocker(facts({ activeSidekick: true }), NOW)).toBe(
			"an active sidekick",
		);
		expect(
			helperForkReleaseBlocker(
				facts({
					turnStatus: "running",
					fork: fork({ releasingAt: minutesAgo(1) }),
				}),
				NOW,
			),
		).toBeNull();
		expect(
			helperForkReleaseBlocker(
				facts({ fork: fork({ deletedAt: minutesAgo(1) }) }),
				NOW,
			),
		).toBe("already released");
	});
});
