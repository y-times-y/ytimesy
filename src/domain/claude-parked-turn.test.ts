import { describe, expect, it } from "vitest";
import {
	CLAUDE_FEED_STALE_MS,
	CLAUDE_FEED_WAKE_QUIET_MS,
	type ClaudeFeedState,
} from "./claude-feed";
import {
	CLAUDE_PARKED_RENEW_MS,
	CLAUDE_PARKED_ROOM_LEASE_MS,
	CLAUDE_TURN_LEASE_SECONDS,
	claudeStepWake,
	nextParkedVmQuiet,
	parkedTurnRenewal,
	parkedVmPauseAt,
	parkedVmPauseCheck,
} from "./claude-parked-turn";
import {
	RETIRED_TURN_MS,
	TURN_COORDINATION_LEASE_MS,
} from "./conversation-turn-control";

const NOW = 1_000_000;
const feed: ClaudeFeedState = {
	run: 1,
	receivedTo: 500,
	consumedTo: 500,
	lastSeen: NOW - 10_000,
	exitStatus: null,
};
const parked = {
	parked: true,
	now: NOW,
	feed,
	pendingCalls: 0,
	waitingTurns: 0,
	room: { expiresAt: NOW + 45_000, cancelled: false },
};

describe("whether a parked Claude Code turn's wake only renews", () => {
	it("renews while its runner is heard and nothing waits", () => {
		expect(parkedTurnRenewal(parked)).toEqual({ renew: true });
	});

	it("runs a step for anything a step must do", () => {
		const cases: [Partial<Parameters<typeof parkedTurnRenewal>[0]>, string][] =
			[
				[{ parked: false }, "not-parked"],
				[{ feed: null }, "feed-silent"],
				[
					{ feed: { ...feed, lastSeen: NOW - CLAUDE_FEED_STALE_MS } },
					"feed-silent",
				],
				[{ feed: { ...feed, lastSeen: 0 } }, "feed-silent"],
				[{ feed: { ...feed, receivedTo: 600 } }, "feed-unread"],
				[{ feed: { ...feed, exitStatus: "0" } }, "feed-exited"],
				[{ pendingCalls: 1 }, "call-pending"],
				[{ waitingTurns: 1 }, "turn-waiting"],
				[{ room: null }, "room-lease"],
				[{ room: { expiresAt: NOW, cancelled: false } }, "room-lease"],
				[{ room: { expiresAt: NOW + 1, cancelled: true } }, "cancelled"],
			];
		for (const [change, reason] of cases)
			expect(parkedTurnRenewal({ ...parked, ...change })).toEqual({
				renew: false,
				reason,
			});
	});
});

describe("when the turn wakes after a step that continues", () => {
	const base = {
		now: NOW,
		pendingCalls: 0,
		waitingTurns: 0,
		unread: null,
		fallbackPauseMs: 15_000,
	};

	it("parks a feed step with nothing to do for the renewal spacing", () => {
		expect(claudeStepWake({ ...base, pause: { kind: "park" } })).toEqual({
			at: NOW + CLAUDE_PARKED_RENEW_MS,
			parked: true,
		});
	});

	it("keeps a polling step's pause and an unpaused step's immediate wake", () => {
		expect(
			claudeStepWake({ ...base, pause: { kind: "pause", ms: 15_000 } }),
		).toEqual({ at: NOW + 15_000, parked: false });
		expect(claudeStepWake({ ...base, pause: null })).toEqual({
			at: NOW,
			parked: false,
		});
	});

	it("never sleeps with a call waiting", () => {
		expect(
			claudeStepWake({ ...base, pause: { kind: "park" }, pendingCalls: 1 }),
		).toEqual({ at: NOW, parked: false });
	});

	it("only pauses briefly while a turn waits behind it (steps refresh its lease)", () => {
		expect(
			claudeStepWake({ ...base, pause: { kind: "park" }, waitingTurns: 1 }),
		).toEqual({ at: NOW + 15_000, parked: false });
	});

	it("wakes a step for lines that arrived during the step, not a renewal", () => {
		expect(
			claudeStepWake({
				...base,
				pause: { kind: "park" },
				unread: { urgent: false, mode: "quiet", pendingSince: NOW },
			}),
		).toEqual({ at: NOW + CLAUDE_FEED_WAKE_QUIET_MS, parked: false });
		expect(
			claudeStepWake({
				...base,
				pause: { kind: "park" },
				unread: { urgent: true, mode: "quiet", pendingSince: NOW },
			}),
		).toEqual({ at: NOW, parked: false });
	});
});

describe("the parked turn's lease windows", () => {
	it("renews well inside its room lease, its Postgres window and the three-minute expiry", () => {
		expect(CLAUDE_PARKED_RENEW_MS).toBeGreaterThanOrEqual(60_000);
		expect(CLAUDE_PARKED_RENEW_MS).toBeLessThanOrEqual(90_000);
		expect(
			CLAUDE_PARKED_ROOM_LEASE_MS - CLAUDE_PARKED_RENEW_MS,
		).toBeGreaterThanOrEqual(30_000);
		expect(
			CLAUDE_TURN_LEASE_SECONDS * 1000 - CLAUDE_PARKED_RENEW_MS,
		).toBeGreaterThanOrEqual(60_000);
		expect(CLAUDE_TURN_LEASE_SECONDS * 1000).toBeLessThan(3 * 60_000);
	});

	it("retires a lapsed turn for longer than its Postgres lease outlives its room lease", () => {
		expect(
			CLAUDE_TURN_LEASE_SECONDS * 1000 - CLAUDE_PARKED_ROOM_LEASE_MS,
		).toBeLessThan(RETIRED_TURN_MS);
		expect(45_000 - TURN_COORDINATION_LEASE_MS).toBeLessThan(RETIRED_TURN_MS);
	});
});

describe("pausing a parked Claude Code turn's VM", () => {
	const GRACE = 10_000;
	const TURN = "turn-1";
	const noted = (since: number | null, toolEnded = true) => ({
		vm: "vm-1",
		userId: "user-1",
		since,
		toolEnded,
	});
	const notPaused = () => null;

	it("keeps the step's quiet, carried back over steps that used no tool", () => {
		const first = nextParkedVmQuiet({
			turnId: TURN,
			previous: null,
			noted: noted(NOW),
			pausedAt: notPaused,
		});
		expect(first).toEqual({
			turnId: TURN,
			userId: "user-1",
			vm: "vm-1",
			quietSince: NOW,
			pausedAt: null,
		});
		// A feed step without a tool call: the quiet began before it.
		expect(
			nextParkedVmQuiet({
				turnId: TURN,
				previous: first,
				noted: noted(NOW + 20_000, false),
				pausedAt: notPaused,
			})?.quietSince,
		).toBe(NOW);
		// A tool call returned in the step: the quiet starts there.
		expect(
			nextParkedVmQuiet({
				turnId: TURN,
				previous: first,
				noted: noted(NOW + 20_000),
				pausedAt: notPaused,
			})?.quietSince,
		).toBe(NOW + 20_000);
		// A tool call still running: no quiet.
		expect(
			nextParkedVmQuiet({
				turnId: TURN,
				previous: first,
				noted: noted(null),
				pausedAt: notPaused,
			})?.quietSince,
		).toBeNull();
		// Another turn's record is not carried.
		expect(
			nextParkedVmQuiet({
				turnId: "turn-2",
				previous: first,
				noted: noted(NOW + 20_000, false),
				pausedAt: notPaused,
			})?.quietSince,
		).toBe(NOW + 20_000);
	});

	it("keeps only a VM still paused when the step noted nothing", () => {
		const previous = {
			turnId: TURN,
			userId: "user-1",
			vm: "vm-1",
			quietSince: NOW,
			pausedAt: null,
		};
		expect(
			nextParkedVmQuiet({
				turnId: TURN,
				previous,
				noted: null,
				pausedAt: notPaused,
			}),
		).toBeNull();
		expect(
			nextParkedVmQuiet({
				turnId: TURN,
				previous,
				noted: null,
				pausedAt: () => NOW + 5,
			}),
		).toEqual({ ...previous, quietSince: null, pausedAt: NOW + 5 });
	});

	it("checks the VM a grace after the quiet began, at once when it is older", () => {
		const quiet = {
			turnId: TURN,
			userId: "user-1",
			vm: "vm-1",
			quietSince: NOW,
			pausedAt: null,
		};
		const at = (now: number, record: typeof quiet | null = quiet) =>
			parkedVmPauseAt({ now, turnId: TURN, quiet: record, graceMs: GRACE });
		expect(at(NOW + 2_000)).toBe(NOW + GRACE);
		expect(at(NOW + 60_000)).toBe(NOW + 60_000);
		expect(at(NOW, null)).toBeNull();
		expect(at(NOW, { ...quiet, quietSince: null } as never)).toBeNull();
		expect(at(NOW, { ...quiet, pausedAt: NOW } as never)).toBeNull();
		expect(at(NOW, { ...quiet, turnId: "turn-2" })).toBeNull();
	});

	it("checks only a turn still parked, with no step and no call", () => {
		const quiet = {
			turnId: TURN,
			userId: "user-1",
			vm: "vm-1",
			quietSince: NOW,
			pausedAt: null as number | null,
		};
		const base = {
			now: NOW + GRACE,
			quiet,
			parkedTurn: TURN as string | null,
			stepping: false,
			pendingCalls: 0,
			graceMs: GRACE,
		};
		expect(parkedVmPauseCheck(base)).toEqual({ check: true, quiet });
		const reason = (change: Partial<typeof base>) => {
			const decision = parkedVmPauseCheck({ ...base, ...change });
			return decision.check ? "check" : decision.reason;
		};
		expect(reason({ quiet: null as never })).toBe("no-quiet");
		expect(reason({ quiet: { ...quiet, pausedAt: NOW } })).toBe("paused");
		expect(reason({ parkedTurn: null })).toBe("not-parked");
		expect(reason({ stepping: true })).toBe("stepping");
		expect(reason({ pendingCalls: 1 })).toBe("call-pending");
		expect(reason({ now: NOW + GRACE - 1 })).toBe("too-soon");
	});
});
