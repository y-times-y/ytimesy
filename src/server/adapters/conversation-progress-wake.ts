import { AsyncLocalStorage } from "node:async_hooks";
import { trackInvocationTask } from "./invocation-tasks";

type Wake = {
	notify: () => Promise<void>;
	running?: Promise<void>;
	again: boolean;
};
const wake = new AsyncLocalStorage<Wake>();
export function withConversationProgressWake<T>(
	notify: () => Promise<void>,
	run: () => Promise<T>,
) {
	return wake.run({ notify, again: false }, run);
}

/**
 * PG keeps the retryable delivery receipt if immediate delivery is unavailable,
 * so the turn does not wait for the relay: relays run beside the step, one at a
 * time, and a wake during a relay runs one more after it, which delivers the
 * newest snapshot. The invocation (and its database scope) waits for the last
 * relay before it ends.
 */
export async function wakeConversationProgress() {
	const current = wake.getStore();
	if (!current) return;
	if (current.running) {
		current.again = true;
		return;
	}
	current.running = trackInvocationTask(
		(async () => {
			do {
				current.again = false;
				try {
					await current.notify();
				} catch {
					/* Recovery must not replay inference. */
				}
			} while (current.again);
		})().finally(() => {
			current.running = undefined;
		}),
	);
}
