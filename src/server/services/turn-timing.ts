/**
 * One compact JSON log line per durable model step: when each phase of the
 * step was first reached, in ms from the step's start (its claim), so the
 * time from "running" to the first token can be attributed on a deployed
 * edge. Ids, phase names, numbers and fixed reason codes only: no user
 * content, model output, paths or secrets. Marks are synchronous and never
 * awaited; the line is written once, when the step ends.
 */

/** Why a first step's first model request did or did not go out before its workspace. */
export type EarlyRequestReason =
	| "early"
	| "not-first-step"
	| "resumed"
	| "not-root-builder"
	| "evaluation"
	| "harness-variant"
	| "not-lean-surface"
	| "workspace-ready"
	| "no-reported-directory"
	| "hook-config-unknown"
	| "prompt-hook-configured";

export type TurnTimingRecord = {
	turnId: string;
	step: number;
	/** Epoch ms the step started (its claim). */
	startedAt: number;
	/** Epoch ms the turn was queued (the send), when known. */
	queuedAt?: number;
	early?: boolean;
	earlyReason?: EarlyRequestReason;
	outcome?: string;
	/** Phase name to ms from startedAt, in the order first reached. */
	phases: Record<string, number>;
};

export function turnTimingLine(record: TurnTimingRecord): string {
	return JSON.stringify({
		ytimesy: "turn-timing",
		turn: record.turnId,
		step: record.step,
		...(record.queuedAt !== undefined && Number.isFinite(record.queuedAt)
			? {
					queuedMs: Math.max(0, Math.round(record.startedAt - record.queuedAt)),
				}
			: {}),
		...(record.early !== undefined ? { early: record.early } : {}),
		...(record.earlyReason ? { earlyReason: record.earlyReason } : {}),
		...(record.outcome ? { outcome: record.outcome } : {}),
		phases: record.phases,
	});
}

export function turnTiming(input: {
	turnId: string;
	step: number;
	startedAt: number;
	queuedAt?: number;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	const record: TurnTimingRecord = {
		turnId: input.turnId,
		step: input.step,
		startedAt: input.startedAt,
		queuedAt: input.queuedAt,
		phases: {},
	};
	let written = false;
	return {
		/** The first time a phase is reached; later marks of it are ignored. */
		mark(phase: string) {
			if (phase in record.phases) return;
			record.phases[phase] = Math.max(0, Math.round(now() - input.startedAt));
		},
		early(taken: boolean, reason: EarlyRequestReason) {
			if (record.earlyReason) return;
			record.early = taken;
			record.earlyReason = reason;
		},
		/** Writes the step's line once. */
		write(outcome: string, log: (line: string) => void = console.log) {
			if (written) return;
			written = true;
			record.outcome = outcome;
			record.phases.end ??= Math.max(0, Math.round(now() - input.startedAt));
			log(turnTimingLine(record));
		},
	};
}

export type TurnTiming = ReturnType<typeof turnTiming>;
