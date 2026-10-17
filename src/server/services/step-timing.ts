import { AsyncLocalStorage } from "node:async_hooks";
import { isDevelopmentEnvironment } from "#/domain/development-environment";

/**
 * Development diagnostics (YTIMESY_DEBUG_STEP_TIMING=1, development only): one log line per
 * durable model step with the wall time spent in each named phase. Spans may
 * overlap (parallel queries, provider calls inside a tool), so their sums are
 * attribution, not a partition of the step. Disabled, every helper is a pass-through.
 */
type Span = { count: number; ms: number; maxMs: number; firstAt: number };
type Trace = {
	startedAt: number;
	spans: Map<string, Span>;
	/** The first individual provider calls, in start order: [at, ms, label]. */
	calls: [number, number, string][];
};

const traces = new AsyncLocalStorage<Trace>();

export function stepTimingEnabled() {
	return (
		process.env.YTIMESY_DEBUG_STEP_TIMING === "1" && isDevelopmentEnvironment()
	);
}

let colo: Promise<string> | undefined;
/** Where this isolate runs: database and provider round trips depend on it. */
function isolateColo() {
	colo ??= fetch("https://www.cloudflare.com/cdn-cgi/trace", {
		signal: AbortSignal.timeout(2_000),
	})
		.then((response) => response.text())
		.then((text) => /^colo=(\w+)$/m.exec(text)?.[1] ?? "unknown")
		.catch(() => "unknown");
	return colo;
}

export async function withStepTrace<T>(
	meta: Record<string, string | number | boolean | null | undefined>,
	run: () => Promise<T>,
): Promise<T> {
	if (!stepTimingEnabled()) return run();
	const trace: Trace = { startedAt: Date.now(), spans: new Map(), calls: [] };
	try {
		return await traces.run(trace, run);
	} finally {
		console.log(
			"step-timing",
			JSON.stringify({
				...meta,
				colo: await isolateColo(),
				totalMs: Date.now() - trace.startedAt,
				spans: Object.fromEntries(
					[...trace.spans].map(([name, span]) => [
						name,
						[span.count, span.ms, span.maxMs, span.firstAt],
					]),
				),
				calls: trace.calls,
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

/** Like timed, and also lists the call itself (first 80 per step) with a short label. */
export async function timedCall<T>(
	name: string,
	label: string,
	run: () => Promise<T>,
) {
	const trace = traces.getStore();
	const startedAt = Date.now();
	try {
		return await timed(name, run);
	} finally {
		if (trace && trace.calls.length < 80)
			trace.calls.push([
				startedAt - trace.startedAt,
				Date.now() - startedAt,
				label.replace(/\s+/g, " ").slice(0, 70),
			]);
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
		let detail = "";
		try {
			const body = JSON.parse(String(init?.body ?? "{}"));
			detail = String(body.command ?? body.path ?? body.state ?? "");
		} catch {}
		return timedCall(
			`${prefix}:${method} ${shape}`,
			`${method} ${shape.split("/").pop()} ${detail}`,
			() => transport(request, init),
		);
	}) as typeof fetch;
}
