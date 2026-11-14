import { AsyncLocalStorage } from "node:async_hooks";

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
	/** The chat's baseline is known but no step journaled its configuration. */
	| "hook-config-unjournaled"
	/** A new chat whose checkout commit is not pinned before its VM is ready. */
	| "hook-config-no-pinned-base"
	/** The pinned commit's configuration could not be read from GitHub. */
	| "hook-config-unreadable"
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
	/**
	 * Sub-phase durations (turnSpan): name to [ms from startedAt of its first
	 * start, its ms] or, when it ran more than once, [first start, total ms,
	 * count, longest ms]. Spans may overlap; they attribute, not partition.
	 */
	spans?: Record<string, number[]>;
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
		...(record.spans && Object.keys(record.spans).length
			? { spans: record.spans }
			: {}),
	});
}

/** At most this many distinct spans per line, so a line stays small. */
const MAX_SPANS = 80;

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
		/** A sub-phase that started at the epoch ms `at` and took `ms`. */
		span(name: string, at: number, ms: number) {
			record.spans ??= {};
			const spans = record.spans;
			const start = Math.max(0, Math.round(at - input.startedAt));
			const took = Math.max(0, Math.round(ms));
			const seen = spans[name];
			if (!seen) {
				if (Object.keys(spans).length < MAX_SPANS) spans[name] = [start, took];
				return;
			}
			const [first, total, count = 1, longest = total] = seen;
			spans[name] = [first, total + took, count + 1, Math.max(longest, took)];
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

type ActiveTiming = {
	mark: (phase: string) => void;
	span?: (name: string, at: number, ms: number) => void;
};

/** The running durable step's timing, for code below it that has no handle on it. */
const activeTiming = new AsyncLocalStorage<ActiveTiming>();

/**
 * Runs a step's work so model, egress and machine code under it can mark
 * phases (markTurnPhase) and record sub-phases (turnSpan).
 */
export function withTurnTimingMarks<T>(
	mark: (phase: string) => void,
	run: () => Promise<T>,
	span?: (name: string, at: number, ms: number) => void,
) {
	return activeTiming.run({ mark, span }, run);
}

/** Marks a phase of the running durable step; a no-op outside one. */
export function markTurnPhase(phase: string) {
	activeTiming.getStore()?.mark(phase);
}

/**
 * Times `run` as a sub-phase of the running durable step (its line's
 * `spans`), whether it succeeds or fails; outside a step it is `run`
 * untouched. Names are fixed codes, never ids, paths or content.
 */
export function turnSpan<T>(name: string, run: () => Promise<T>): Promise<T> {
	const span = activeTiming.getStore()?.span;
	if (!span) return run();
	const at = Date.now();
	const done = () => span(name, at, Date.now() - at);
	let running: Promise<T>;
	try {
		running = run();
	} catch (error) {
		done();
		throw error;
	}
	running.then(done, done);
	return running;
}

/** A request's method and coarse path shape (ids become :id), a fixed span name. */
export function requestShape(request: RequestInfo | URL, init?: RequestInit) {
	const url = new URL(
		request instanceof Request ? request.url : String(request),
	);
	const method =
		init?.method ?? (request instanceof Request ? request.method : "GET");
	const shape = url.pathname
		.split("/")
		.filter(Boolean)
		.map((part) =>
			/^v\d+$/.test(part)
				? part
				: /^[0-9a-z]{16,}$/i.test(part) || /\d/.test(part)
					? ":id"
					: part,
		)
		.join("/");
	return `${method} ${shape}`;
}

/**
 * Times every request through a fetch as a span of the running durable step
 * (`<prefix>:<method> <path shape>`, so provider round trips are counted
 * and summed); outside a step it is the fetch it wraps, untouched.
 */
export function turnSpanFetch(prefix: string, fetch: typeof globalThis.fetch) {
	const spanned: typeof globalThis.fetch = (input, init) => {
		if (!activeTiming.getStore()?.span) return fetch(input, init);
		let name: string;
		try {
			name = `${prefix}:${requestShape(input, init)}`;
		} catch {
			return fetch(input, init);
		}
		return turnSpan(name, () => fetch(input, init));
	};
	return spanned;
}

/**
 * A model provider's fetch that marks, for the running durable step, when its
 * first request started (modelFetchStarted), when response headers arrived
 * (modelHeaders) and when the first body byte (the first SSE bytes) arrived
 * (modelFirstByte). With firstToken, network time and model time separate.
 * Outside a durable step it is the fetch it wraps, untouched.
 */
export function timedModelFetch(fetch: typeof globalThis.fetch) {
	const timed: typeof globalThis.fetch = async (input, init) => {
		const mark = activeTiming.getStore()?.mark;
		if (!mark) return fetch(input, init);
		mark("modelFetchStarted");
		const response = await fetch(input, init);
		mark("modelHeaders");
		if (!response.body) return response;
		let seen = false;
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					if (!seen) {
						seen = true;
						mark("modelFirstByte");
					}
					controller.enqueue(chunk);
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return timed;
}
