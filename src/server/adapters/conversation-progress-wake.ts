import { AsyncLocalStorage } from "node:async_hooks";

const wake = new AsyncLocalStorage<() => Promise<void>>();
export function withConversationProgressWake<T>(
	notify: () => Promise<void>,
	run: () => Promise<T>,
) {
	return wake.run(notify, run);
}

/** PG keeps the retryable delivery receipt if immediate delivery is unavailable. */
export async function wakeConversationProgress() {
	try {
		await wake.getStore()?.();
	} catch {
		/* Recovery must not replay inference. */
	}
}
