import { AsyncLocalStorage } from "node:async_hooks";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const binding = new AsyncLocalStorage<Fetch>();

/** Inside the web Worker, calls to the edge executor use its service binding. */
export function withExecutorBinding<T>(fetcher: Fetch, run: () => Promise<T>) {
	return binding.run(fetcher, run);
}

/**
 * Fetch for edge-executor endpoints (job admission, turn admission, realtime).
 * Outside a Worker it is the ordinary network fetch to the configured URL.
 */
export function executorFetch(input: string, init?: RequestInit) {
	return (binding.getStore() ?? fetch)(input, init);
}
