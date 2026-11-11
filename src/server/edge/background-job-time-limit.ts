/**
 * A background job holds its Durable Object awake, and Cloudflare bills the
 * object for every second it is awake, however little CPU the job uses. A job
 * waiting on a call that never answers once held one awake for 3.6 hours
 * (Nov 10). These jobs are short by design, so a run that outlives the limit
 * is given up on and treated like an interrupted one (replayed when safe).
 *
 * Normal runs seen in production reach about 26 minutes at most, so the limit
 * sits above that and far below the hours a hung run costs.
 */
export const JOB_TIME_LIMIT_MS = 30 * 60_000;
/** A run longer than this is logged with its kind, to learn which kinds run long. */
export const SLOW_JOB_LOG_MS = 60_000;

export class JobTimeLimitReached extends Error {
	constructor() {
		super("Background job exceeded its time limit.");
		this.name = "JobTimeLimitReached";
	}
}

/**
 * Runs `run`, rejecting with JobTimeLimitReached once `limitMs` passes. The
 * run itself cannot be cancelled, so its work may still finish later; the
 * caller stops waiting for it, which lets the object go idle. A run that
 * takes longer than `slowMs` is logged when it ends, or when it is given up on.
 */
export async function runWithJobTimeLimit<T>(
	job: { readonly id: string; readonly kind: string },
	run: () => Promise<T>,
	options: { limitMs?: number; slowMs?: number; now?: () => number } = {},
): Promise<T> {
	const limitMs = options.limitMs ?? JOB_TIME_LIMIT_MS;
	const slowMs = options.slowMs ?? SLOW_JOB_LOG_MS;
	const now = options.now ?? Date.now;
	const started = now();
	const logSlow = (outcome: string) => {
		const elapsedMs = now() - started;
		if (elapsedMs >= slowMs)
			console.warn("Background job ran long.", {
				id: job.id,
				kind: job.kind,
				outcome,
				elapsedMs,
			});
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new JobTimeLimitReached()), limitMs);
	});
	try {
		const result = await Promise.race([run(), limit]);
		logSlow("finished");
		return result;
	} catch (error) {
		logSlow(error instanceof JobTimeLimitReached ? "time-limit" : "error");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
