// Detached hard-set runs (`--detach`, docs/hard-set.md): the invocation that
// starts a task returns once its turn runs on the development edge, and later
// `--collect` invocations finish it. Each step fits the owner's ten-minute
// limit; the agent budget does not have to. Everything a later invocation
// needs is in the task's record on disk, and the edge cancels the turn at its
// deadline (the session's turn-deadline receipt) whether or not anyone polls.
//
// This module is the pure part: the state a record carries and what a
// collect does with it at a given moment. scripts/hard-set.ts does the I/O.
import type { DetachedSlot } from "../smoke/eval-user";

/** What a later invocation needs to start or finish a detached task. */
export type DetachedPlan = {
	dataset: string;
	model: string;
	reasoning: string | null;
	/** The --variant flags the run was started with. */
	variantFlags: string[];
	agentSeconds: number;
	transcripts: boolean;
};

export type DetachedPhase =
	/** Waiting for a Codex slot; a collect starts it. */
	| "queued"
	/** The turn runs on the edge. */
	| "running"
	/** Staging and grading began (an interrupted finalize is retried). */
	| "finalizing";

export type DetachedState = {
	phase: DetachedPhase;
	plan: DetachedPlan;
	userId: string | null;
	sessionId: string | null;
	agentVm: string | null;
	workdir: string | null;
	/** Epoch ms. */
	agentStartedAt: number | null;
	agentDeadlineAt: number | null;
	/** The agent VM's Freestyle lifetime ends then: finalize before it. */
	vmExpiresAt: number | null;
	slot: DetachedSlot | null;
	/** A grader VM created by an interrupted finalize (deleted on retry). */
	graderVm: string | null;
	finalizeStartedAt: number | null;
	/** The latest turn state a collect read. */
	turnState: string | null;
	cancelSentAt: number | null;
	/**
	 * An invocation is starting or finalizing the task until then (epoch ms,
	 * its ceiling plus its exit grace): other invocations leave it alone.
	 */
	lockedUntil?: number | null;
	lockOwner?: string | null;
};

/** Time a start needs left in the invocation: setup (at most 300 s) and admission. */
export const START_NEEDS_MS = 7 * 60_000;
/** Time a finalize needs left: settle, stage the trees, boot the grader, upload. */
export const FINALIZE_NEEDS_MS = 6 * 60_000;
/** A cancelled turn has this long to settle before it is finalized as unsettled. */
export const SETTLE_GRACE_MS = 45_000;
/** How long after its deadline a task's VM (and eval user) waits for a collect. */
export const COLLECT_WINDOW_MS = 60 * 60_000;

export const newDetachedState = (plan: DetachedPlan): DetachedState => ({
	phase: "queued",
	plan,
	userId: null,
	sessionId: null,
	agentVm: null,
	workdir: null,
	agentStartedAt: null,
	agentDeadlineAt: null,
	vmExpiresAt: null,
	slot: null,
	graderVm: null,
	finalizeStartedAt: null,
	turnState: null,
	cancelSentAt: null,
	lockedUntil: null,
	lockOwner: null,
});

/** Another invocation holds the task (starting or finalizing it). */
export const lockedByOther = (
	state: DetachedState,
	owner: string,
	now: number,
) =>
	!!state.lockedUntil && state.lockedUntil > now && state.lockOwner !== owner;

export type CollectAction =
	| { kind: "start" }
	| { kind: "poll" }
	| { kind: "cancel"; reason: string }
	| { kind: "finalize"; unsettled: boolean }
	| { kind: "expire"; reason: string }
	| { kind: "wait"; reason: string };

const isLive = (state: string | null) =>
	state === null || state === "queued" || state === "running";

/**
 * What a collect does with a detached task now. `turnState` is the state it
 * just read (null when not read yet), `invocationEndsAt` this invocation's
 * ceiling, `stopping` whether starting new work is off (a signal or the
 * usage limit), `usageLimit` whether the Codex usage limit was hit (live
 * turns are cancelled then; a signal to the collect never cancels them).
 */
export function collectAction(
	state: DetachedState,
	input: {
		now: number;
		invocationEndsAt: number;
		turnState: string | null;
		stopping: boolean;
		usageLimit?: boolean;
	},
): CollectAction {
	const left = input.invocationEndsAt - input.now;
	if (state.phase === "queued") {
		if (input.stopping || input.usageLimit)
			return { kind: "wait", reason: "run stopped" };
		if (left < START_NEEDS_MS)
			return { kind: "wait", reason: "too little invocation time to start" };
		return { kind: "start" };
	}
	if (state.vmExpiresAt !== null && input.now > state.vmExpiresAt - 60_000)
		return {
			kind: "expire",
			reason: "No collect before the agent VM's lifetime ended.",
		};
	const deadline = state.agentDeadlineAt ?? Number.POSITIVE_INFINITY;
	const settled = !isLive(input.turnState);
	if (state.phase === "running") {
		if (input.turnState === null) return { kind: "poll" };
		if (!settled && input.now > deadline + SETTLE_GRACE_MS) {
			if (left < FINALIZE_NEEDS_MS)
				return { kind: "wait", reason: "unsettled; finalize next collect" };
			return { kind: "finalize", unsettled: true };
		}
		if (!settled && input.now > deadline && state.cancelSentAt === null)
			return {
				kind: "cancel",
				reason: "agent time limit",
			};
		if (!settled && input.usageLimit && state.cancelSentAt === null)
			return { kind: "cancel", reason: "Codex usage limit" };
		if (!settled) return { kind: "wait", reason: "agent working" };
	}
	// Settled, or a finalize that an earlier invocation did not finish.
	if (left < FINALIZE_NEEDS_MS)
		return { kind: "wait", reason: "finalize next collect" };
	return { kind: "finalize", unsettled: false };
}

/** Whether a collect should keep polling this task in the current invocation. */
export function worthWaiting(
	state: DetachedState,
	now: number,
	invocationEndsAt: number,
) {
	if (state.phase !== "running" || state.agentDeadlineAt === null) return false;
	// The turn settles by its deadline (+ grace) and still leaves time to finalize.
	return (
		Math.max(now, state.agentDeadlineAt + SETTLE_GRACE_MS) +
			FINALIZE_NEEDS_MS <=
		invocationEndsAt
	);
}

type StatusRecord = {
	run: string;
	task: string;
	attempt: string;
	variant: string;
	status: string;
	state: string;
	agentSec: number;
	agentBudgetSec: number;
	agentRequestedSec: number;
	reward: number | null;
	passed: boolean;
	detached?: DetachedState | null;
};

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)}m`;

/** One row per detached record: phase, agent time used vs budget, what is next. */
export function detachedStatusRows(
	records: readonly StatusRecord[],
	now: number,
): string[][] {
	const rows = [
		[
			"run",
			"task",
			"variant",
			"phase",
			"turn",
			"agent used/budget",
			"deadline",
			"next",
		],
	];
	for (const record of records) {
		const state = record.detached;
		if (!state) continue;
		const done = record.status === "final" || record.status === "error";
		const phase = done
			? record.status
			: record.status === "grading"
				? "grading"
				: state.phase;
		const budget = record.agentBudgetSec || record.agentRequestedSec;
		// Agent time so far: the record's once settled, else until now (at most the deadline).
		const used =
			record.agentSec ||
			(state.agentStartedAt === null
				? 0
				: Math.round(
						(Math.min(now, state.agentDeadlineAt ?? now) -
							state.agentStartedAt) /
							1000,
					));
		const deadline =
			state.agentDeadlineAt === null
				? "-"
				: state.agentDeadlineAt > now
					? `in ${minutes(state.agentDeadlineAt - now)}`
					: `${minutes(now - state.agentDeadlineAt)} ago`;
		const next = done
			? record.status === "final"
				? record.passed
					? "PASS"
					: `fail (reward ${record.reward ?? "-"})`
				: "-"
			: record.status === "grading"
				? "--collect (tests running)"
				: state.phase === "queued"
					? "--collect starts it when a Codex slot frees"
					: state.agentDeadlineAt !== null && state.agentDeadlineAt > now
						? "agent working"
						: "--collect now";
		rows.push([
			record.run,
			`${record.task}.${record.attempt}`,
			record.variant,
			phase,
			state.turnState ?? "-",
			`${minutes(used * 1000)}/${minutes(budget * 1000)}`,
			deadline,
			next,
		]);
	}
	return rows;
}
