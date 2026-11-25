import { AsyncLocalStorage } from "node:async_hooks";
import { boundedWait } from "./bounded";

/** Best-effort tasks are waited for this long once the invocation's work is done. */
export const INVOCATION_TASKS_DRAIN_MS = 15_000;

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
			if (pending.size)
				await boundedWait(
					Promise.allSettled([...pending]),
					INVOCATION_TASKS_DRAIN_MS,
					() =>
						console.warn("Invocation tasks were left running.", {
							tasks: pending.size,
						}),
				);
		}
	});
}
