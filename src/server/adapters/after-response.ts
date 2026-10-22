import { AsyncLocalStorage } from "node:async_hooks";

type Defer = (work: Promise<unknown>) => void;
const scope = new AsyncLocalStorage<Defer>();

/**
 * Runs one web request whose follow-up work may finish after its response:
 * `defer` keeps the request (its database scope and the platform's
 * waitUntil) open until that work settled.
 */
export function withAfterResponse<T>(defer: Defer, run: () => Promise<T>) {
	return scope.run(defer, run);
}

/**
 * Starts `work` now and lets the response go out before it finishes, when the
 * request allows it (a web request on the edge). Returns false outside one:
 * the caller then awaits the work itself.
 */
export function startAfterResponse(work: () => Promise<unknown>): boolean {
	const defer = scope.getStore();
	if (!defer) return false;
	defer(work().catch(() => undefined));
	return true;
}
