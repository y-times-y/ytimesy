import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	COLLECT_WINDOW_MS,
	collectAction,
	type DetachedState,
	detachedStatusRows,
	FINALIZE_NEEDS_MS,
	lockedByOther,
	newDetachedState,
	SETTLE_GRACE_MS,
	START_NEEDS_MS,
	worthWaiting,
} from "../scripts/hard-set/detached";
import {
	detachedHold,
	detachedSlotHolders,
	releaseDetachedSlot,
	slotHolderGone,
	tryDetachedSlot,
} from "../scripts/smoke/eval-user";

const plan = {
	dataset: "/data",
	model: "gpt-6.1-sol",
	reasoning: null,
	variantFlags: ["review=on"],
	agentSeconds: 1800,
	transcripts: false,
};
const NOW = 1_000_000_000_000;
const MIN = 60_000;

function running(extra: Partial<DetachedState> = {}): DetachedState {
	return {
		...newDetachedState(plan),
		phase: "running",
		userId: "eval-0123456789ab",
		sessionId: "s",
		agentVm: "vm",
		agentStartedAt: NOW - 10 * MIN,
		agentDeadlineAt: NOW + 20 * MIN,
		vmExpiresAt: NOW + 20 * MIN + COLLECT_WINDOW_MS,
		...extra,
	};
}

const at = (
	state: DetachedState,
	turnState: string | null,
	extra: { now?: number; left?: number; stopping?: boolean } = {},
) => {
	const now = extra.now ?? NOW;
	return collectAction(state, {
		now,
		invocationEndsAt: now + (extra.left ?? 10 * MIN),
		turnState,
		stopping: extra.stopping ?? false,
	});
};

describe("collectAction", () => {
	it("starts a queued task only with time for setup and while not stopping", () => {
		const queued = newDetachedState(plan);
		expect(at(queued, null)).toEqual({ kind: "start" });
		expect(at(queued, null, { left: START_NEEDS_MS - 1 }).kind).toBe("wait");
		expect(at(queued, null, { stopping: true }).kind).toBe("wait");
	});

	it("leaves a turn alone before its deadline", () => {
		expect(at(running(), "running")).toEqual({
			kind: "wait",
			reason: "agent working",
		});
		expect(at(running(), null).kind).toBe("poll");
	});

	it("finalizes a settled turn when the invocation has time, else defers", () => {
		expect(at(running(), "completed")).toEqual({
			kind: "finalize",
			unsettled: false,
		});
		expect(at(running(), "cancelled", { left: FINALIZE_NEEDS_MS - 1 })).toEqual(
			{ kind: "wait", reason: "finalize next collect" },
		);
	});

	it("cancels at the deadline once, then finalizes an unsettled turn after the grace", () => {
		const late = running({ agentDeadlineAt: NOW - 1000 });
		expect(at(late, "running")).toEqual({
			kind: "cancel",
			reason: "agent time limit",
		});
		const cancelled = { ...late, cancelSentAt: NOW - 500 };
		expect(at(cancelled, "running").kind).toBe("wait");
		const stuck = running({
			agentDeadlineAt: NOW - SETTLE_GRACE_MS - 1,
			cancelSentAt: NOW - SETTLE_GRACE_MS,
		});
		expect(at(stuck, "running")).toEqual({ kind: "finalize", unsettled: true });
	});

	it("cancels a live turn on the usage limit, never on a signal to the collect", () => {
		expect(
			collectAction(running(), {
				now: NOW,
				invocationEndsAt: NOW + 10 * MIN,
				turnState: "running",
				stopping: true,
				usageLimit: true,
			}),
		).toEqual({ kind: "cancel", reason: "Codex usage limit" });
		expect(at(running(), "running", { stopping: true }).kind).toBe("wait");
	});

	it("leaves a task another invocation is starting or finalizing", () => {
		const state = running({ lockedUntil: NOW + MIN, lockOwner: "other" });
		expect(lockedByOther(state, "me", NOW)).toBe(true);
		expect(lockedByOther(state, "other", NOW)).toBe(false);
		expect(lockedByOther(state, "me", NOW + 2 * MIN)).toBe(false);
		expect(lockedByOther(running(), "me", NOW)).toBe(false);
	});

	it("retries an interrupted finalize", () => {
		expect(at(running({ phase: "finalizing" }), null)).toEqual({
			kind: "finalize",
			unsettled: false,
		});
	});

	it("gives up once the agent VM's lifetime is (nearly) over", () => {
		expect(at(running({ vmExpiresAt: NOW + 30_000 }), "completed").kind).toBe(
			"expire",
		);
	});
});

describe("worthWaiting", () => {
	it("keeps polling only when the turn ends in time to finalize in this invocation", () => {
		const state = running({ agentDeadlineAt: NOW + 2 * MIN });
		expect(worthWaiting(state, NOW, NOW + 10 * MIN)).toBe(true);
		expect(worthWaiting(state, NOW, NOW + 8 * MIN)).toBe(false);
		expect(worthWaiting(running(), NOW, NOW + 10 * MIN)).toBe(false);
		expect(worthWaiting(newDetachedState(plan), NOW, NOW + 10 * MIN)).toBe(
			false,
		);
	});
});

describe("detachedStatusRows", () => {
	const base = {
		run: "hs30-rvon",
		task: "shadow-relay",
		attempt: "1",
		variant: "review=on",
		state: "running",
		agentSec: 0,
		agentBudgetSec: 1800,
		agentRequestedSec: 1800,
		reward: null,
		passed: false,
	};
	it("reports agent time used against the budget and what comes next", () => {
		const rows = detachedStatusRows(
			[
				{ ...base, status: "running", detached: running() },
				{
					...base,
					task: "heat-pump-warranty",
					status: "queued",
					agentBudgetSec: 0,
					detached: newDetachedState(plan),
				},
				{
					...base,
					task: "mvcc-lsm-compaction",
					status: "final",
					agentSec: 1500,
					reward: 1,
					passed: true,
					detached: running({ agentDeadlineAt: NOW - MIN }),
				},
				{ ...base, task: "attached", status: "final" },
			],
			NOW,
		);
		expect(rows).toHaveLength(4);
		expect(rows[1]).toEqual([
			"hs30-rvon",
			"shadow-relay.1",
			"review=on",
			"running",
			"-",
			"10.0m/30.0m",
			"in 20.0m",
			"agent working",
		]);
		expect(rows[2][3]).toBe("queued");
		expect(rows[2][5]).toBe("0.0m/30.0m");
		expect(rows[2][7]).toContain("Codex slot");
		expect(rows[3][5]).toBe("25.0m/30.0m");
		expect(rows[3][6]).toBe("1.0m ago");
		expect(rows[3][7]).toBe("PASS");
	});
	it("caps a running turn's time at its deadline", () => {
		const rows = detachedStatusRows(
			[
				{
					...base,
					status: "running",
					detached: running({ agentDeadlineAt: NOW - 5 * MIN }),
				},
			],
			NOW,
		);
		expect(rows[1][5]).toBe("5.0m/30.0m");
		expect(rows[1][7]).toBe("--collect now");
	});
});

describe("detached slots and users", () => {
	it("frees a detached slot at its expiry and a dead process's slot", () => {
		expect(slotHolderGone(`detached:${NOW + 1}:x:id`, NOW)).toBe(false);
		expect(slotHolderGone(`detached:${NOW - 1}:x:id`, NOW)).toBe(true);
		expect(slotHolderGone("detached:garbage", NOW)).toBe(true);
		expect(slotHolderGone("123:token", NOW, () => true, 1)).toBe(false);
		expect(slotHolderGone("123:token", NOW, () => false, 1)).toBe(true);
		expect(slotHolderGone("1:token", NOW, () => false, 1)).toBe(false);
		expect(slotHolderGone("", NOW)).toBe(false);
	});

	it("takes slots up to the limit without waiting and releases them", async () => {
		const name = `test-detached-${randomUUID()}`;
		const until = Date.now() + 60_000;
		const a = await tryDetachedSlot(name, 2, "run/a.1", until);
		const b = await tryDetachedSlot(name, 2, "run/b.1", until);
		expect(a && b).toBeTruthy();
		expect(await tryDetachedSlot(name, 2, "run/c.1", until)).toBeNull();
		expect((await detachedSlotHolders(name, 2)).sort()).toEqual([
			"run/a.1",
			"run/b.1",
		]);
		if (!a || !b) throw new Error("no slot");
		await releaseDetachedSlot(a);
		await releaseDetachedSlot(a);
		const c = await tryDetachedSlot(name, 2, "run/c.1", until);
		expect(c?.path).toBe(a.path);
		if (c) await releaseDetachedSlot(c);
		await releaseDetachedSlot(b);
		// An expired holder is replaced.
		const old = await tryDetachedSlot(name, 1, "run/old.1", Date.now() - 1);
		const fresh = await tryDetachedSlot(name, 1, "run/new.1", until);
		expect(fresh?.path).toBe(old?.path);
		if (fresh) await releaseDetachedSlot(fresh);
	});

	it("keeps a detached user from --cleanup until its hold ends", () => {
		expect(detachedHold({ detachedUntil: NOW + 1 }, NOW)).toBe(true);
		expect(detachedHold({ detachedUntil: NOW - 1 }, NOW)).toBe(false);
		expect(detachedHold({}, NOW)).toBe(false);
	});
});
