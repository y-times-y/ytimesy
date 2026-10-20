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
	/** --task-suffix: text appended to every task's message (absent on older plans). */
	taskSuffix?: string | null;
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
	/**
	 * The agent VM's Freestyle lifetime (ttl) ends then: finalize before it.
	 * Its runtime cap is another limit, metered by the edge once the turn
	 * starts (runtimeCapFor).
	 */
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

/** The agent VM's provider runtime counters (Freestyle VM data). */
export type VmRuntime = {
	readonly totalRunSeconds?: number | null;
	readonly maxRunTotalSeconds?: number | null;
};

/** A finished turn's VM with less runtime than this left gets a collect warning. */
export const RUNTIME_WARN_SEC = 15 * 60;

/** Runtime the provider still allows before it stops the VM; null when uncapped or unknown. */
export function runtimeLeftSec(runtime: VmRuntime): number | null {
	const cap = runtime.maxRunTotalSeconds;
	if (cap == null || cap < 0) return null;
	return Math.max(0, cap - (runtime.totalRunSeconds ?? 0));
}

/**
 * The runtime cap that leaves `needSec` more for a finalize, or null when the
 * current cap already does. Only ever raises it.
 *
 * Why a finalize must own the cap: the hard set creates the agent VM with a
 * cap covering setup, the agent budget and the collect window, but its slug
 * names the session, so the development edge's usage admission meters the VM
 * once the turn starts and replaces that cap with short paid chunks (300 s
 * at a time, extended only while the edge uses it) and trims it to the used
 * runtime when the VM pauses. A collect after the turn then finds the cap
 * spent, and this invocation (admission off) cannot extend it the product's
 * way (hs30b-rvon: "The machine's runtime budget is used up and this
 * deployment cannot extend it").
 */
export function runtimeCapFor(
	runtime: VmRuntime,
	needSec: number,
): number | null {
	const left = runtimeLeftSec(runtime);
	if (left === null || left >= needSec) return null;
	return Math.ceil((runtime.totalRunSeconds ?? 0) + needSec);
}

/** A collect's warning for a finished turn whose agent VM is near its runtime limit. */
export function runtimeWarning(
	state: Pick<DetachedState, "phase" | "agentVm" | "turnState">,
	runtime: VmRuntime & { readonly state?: string | null },
): string | null {
	if (state.phase === "queued" || isLive(state.turnState)) return null;
	const left = runtimeLeftSec(runtime);
	if (left === null || left >= RUNTIME_WARN_SEC) return null;
	return `agent VM ${state.agentVm} (${runtime.state ?? "?"}) has ${minutes(left * 1000)} of runtime left (${runtime.totalRunSeconds ?? "?"}s used of a ${runtime.maxRunTotalSeconds}s cap): the edge's usage admission metered it after the turn; the finalize raises the cap before resuming it.`;
}

export type WakeResult =
	| { ok: true; resumed: boolean; from: string }
	| { ok: false; gone: boolean; reason: string };

/**
 * Wakes the agent VM before a finalize touches it. The product pauses an
 * idle workspace VM (PRODUCT_IDLE_TIMEOUT_SECONDS) and the edge resets its
 * idle timeout on every resume, so a turn that ends early leaves a paused VM
 * long before the collect: raise its runtime cap to cover the finalize
 * (`budget`), resume it the product's way (`resume`), then hold it awake
 * for the finalize (`hold`, best effort). Transient failures
 * are retried; a VM that no longer exists (`state` resolves null: deleted,
 * or its lifetime ended) is reported as gone, never thrown.
 */
export async function wakeForFinalize(
	deps: {
		/** The VM's provider state; null when the VM no longer exists. */
		state: () => Promise<string | null>;
		/** Raises the provider runtime cap so the finalize fits (runtimeCapFor). */
		budget: () => Promise<void>;
		resume: () => Promise<void>;
		hold: () => Promise<void>;
		sleep: (ms: number) => Promise<void>;
	},
	attempts = 4,
): Promise<WakeResult> {
	let last = "unknown error";
	let from: string | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			let state = await deps.state();
			if (state === null)
				return {
					ok: false,
					gone: true,
					reason: "The agent VM no longer exists (deleted or expired).",
				};
			from ??= state;
			// Before a resume: a spent cap refuses it.
			await deps.budget();
			if (state !== "running") {
				await deps.resume();
				state = await deps.state();
				if (state === null)
					return {
						ok: false,
						gone: true,
						reason: "The agent VM no longer exists (deleted or expired).",
					};
				if (state !== "running")
					throw new Error(`The agent VM is ${state} after a resume.`);
			}
			await deps.hold().catch(() => {});
			// A VM found not running was resumed, on this try or an earlier one.
			return { ok: true, resumed: from !== "running", from };
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
			if (attempt < attempts - 1) await deps.sleep(5_000 * (attempt + 1));
		}
	}
	return {
		ok: false,
		gone: false,
		reason: `The agent VM could not be resumed (${attempts} tries): ${last.slice(0, 300)}`,
	};
}
