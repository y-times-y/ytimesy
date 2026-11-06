import type { BackgroundJob } from "../../domain/background-job";

/**
 * Durable Object instances of one class share a Worker isolate (128 MB). Every
 * BackgroundJobRunner is its own instance, so several memory or checkpoint jobs
 * can run side by side in one isolate: a checkpoint alone holds the guest's
 * payload (up to 20 MB) plus its JSON, sealed and signed copies, and a memory
 * save holds a cloned repo. When the isolate runs out, the platform resets it
 * and every job in it is cut off and runs again.
 *
 * Each heavy kind has a weight against a per-isolate budget. A job that does not
 * fit is deferred by an alarm, never waited for inside the handler, so it
 * costs no active time. A job always fits when nothing else is held.
 */
export const ISOLATE_JOB_BUDGET = 100;

const HEAVY_WEIGHTS: Partial<Record<BackgroundJob["kind"], number>> = {
	// payload 20 MB x about 5 live copies while it is exported, hashed, wrapped and sealed
	checkpoint: 70,
	// a cloned memory repo (packfile, objects, working tree, index) and its snapshot
	memory: 30,
	// screenshots and recordings are buffered for upload
	"pr-evidence": 30,
};

const DEFER_BASE_MS = 3_000;
const DEFER_JITTER_MS = 5_000;

let held = 0;

export function jobWeight(kind: BackgroundJob["kind"]) {
	return HEAVY_WEIGHTS[kind] ?? 0;
}

/** A release function when the job may run now in this isolate, otherwise null. */
export function tryAdmitJob(kind: BackgroundJob["kind"]): (() => void) | null {
	const weight = jobWeight(kind);
	if (weight === 0) return () => {};
	if (held > 0 && held + weight > ISOLATE_JOB_BUDGET) return null;
	held += weight;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		held -= weight;
	};
}

/** When a deferred job looks again; spread so deferred jobs do not all return together. */
export function deferralDelayMs(random: () => number = Math.random) {
	return DEFER_BASE_MS + Math.floor(random() * DEFER_JITTER_MS);
}

/**
 * Delay before the next look at a job whose peer was busy. The first minutes
 * stay at 15 s (a turn usually ends soon); a longer wait backs off so the
 * object sleeps between looks instead of staying active for the whole hour.
 * The total stays within the original 240 x 15 s deadline.
 */
export const PEER_DEADLINE_MS = 240 * 15_000;

export function peerRetryDelayMs(attempts: number) {
	if (attempts < 8) return 15_000;
	if (attempts < 20) return 30_000;
	return 60_000;
}

/** Whether the total wait so far (attempts already made) has reached the deadline. */
export function peerDeadlineReached(attempts: number) {
	let waited = 0;
	for (let attempt = 0; attempt < attempts; attempt++)
		waited += peerRetryDelayMs(attempt);
	return waited >= PEER_DEADLINE_MS;
}

/** Test hook: the weight currently held in this isolate. */
export function heldJobWeight() {
	return held;
}
