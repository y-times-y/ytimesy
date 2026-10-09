import { AsyncLocalStorage } from "node:async_hooks";

const tasks = new AsyncLocalStorage<Set<Promise<unknown>>>();

/** Best-effort work may outlive its caller, but must not escape a Worker invocation. */
export function trackInvocationTask<T>(work: Promise<T>): Promise<T> {
	const current = tasks.getStore();
	if (current) {
		current.add(work);
		void work.then(
			() => current.delete(work),
			() => current.delete(work),
		);
	}
	return work;
}

export async function withInvocationTasks<T>(
	run: () => Promise<T>,
): Promise<T> {
	const pending = new Set<Promise<unknown>>();
	return tasks.run(pending, async () => {
		try {
			return await run();
		} finally {
			while (pending.size) await Promise.allSettled([...pending]);
		}
	});
}
