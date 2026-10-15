import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Development diagnostics (YTIMESY_DEBUG_STEP_TIMING=1): one log line per
 * durable model step with the wall time spent in each named phase. Spans may
 * overlap (parallel queries, provider calls inside a tool), so their sums are
 * attribution, not a partition of the step. Disabled, every helper is a pass-through.
 */
type Span = { count: number; ms: number; maxMs: number; firstAt: number };
type Trace = { startedAt: number; spans: Map<string, Span> };

const traces = new AsyncLocalStorage<Trace>();

export function stepTimingEnabled() {
	return process.env.YTIMESY_DEBUG_STEP_TIMING === "1";
}

export async function withStepTrace<T>(
	meta: Record<string, string | number | boolean | null | undefined>,
	run: () => Promise<T>,
): Promise<T> {
	if (!stepTimingEnabled()) return run();
	const trace: Trace = { startedAt: Date.now(), spans: new Map() };
	try {
		return await traces.run(trace, run);
	} finally {
		console.log(
			"step-timing",
			JSON.stringify({
				...meta,
				totalMs: Date.now() - trace.startedAt,
				spans: Object.fromEntries(
					[...trace.spans].map(([name, span]) => [
						name,
						[span.count, span.ms, span.maxMs, span.firstAt],
					]),
				),
			}),
		);
	}
}

/** Records a duration measured elsewhere (a model call, a tool) in the current trace. */
export function recordStepTiming(name: string, ms: number, startedAt?: number) {
	const trace = traces.getStore();
	if (!trace) return;
	const span = trace.spans.get(name);
	const at = (startedAt ?? Date.now() - ms) - trace.startedAt;
	if (span) {
		span.count++;
		span.ms += ms;
		span.maxMs = Math.max(span.maxMs, ms);
	} else trace.spans.set(name, { count: 1, ms, maxMs: ms, firstAt: at });
}

export async function timed<T>(name: string, run: () => Promise<T>) {
	if (!traces.getStore()) return run();
	const startedAt = Date.now();
	try {
		return await run();
	} finally {
		recordStepTiming(name, Date.now() - startedAt, startedAt);
	}
}

/** Times every request through a fetch, named by method and a coarse path shape. */
export function timedFetch(prefix: string, transport: typeof fetch) {
	return (async (request: RequestInfo | URL, init?: RequestInit) => {
		if (!traces.getStore()) return transport(request, init);
		const url = new URL(
			request instanceof Request ? request.url : String(request),
		);
		const method =
			init?.method ?? (request instanceof Request ? request.method : "GET");
		const shape = url.pathname
			.split("/")
			.filter(Boolean)
			.map((part) =>
				/^[0-9a-z]{16,}$/i.test(part) || /\d/.test(part) ? ":id" : part,
			)
			.join("/");
		return timed(`${prefix}:${method} ${shape}`, () =>
			transport(request, init),
		);
	}) as typeof fetch;
}
