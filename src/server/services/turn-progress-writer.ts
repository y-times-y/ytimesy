import type { SessionItem } from "#/domain/session-item";

/** Streams do not wait on storage; checkpoint/finalization must drain this writer first. */
export function turnProgressWriter(
	write: (items: readonly SessionItem[]) => Promise<void>,
	onFailure: (error: unknown) => void,
) {
	let latest: readonly SessionItem[] | undefined;
	let running: Promise<void> | undefined;
	let failed = false;
	let failure: unknown;
	/** A throttled snapshot waiting for its window to end (offerLater). */
	let later: ReturnType<typeof setTimeout> | undefined;
	let laterItems: readonly SessionItem[] | undefined;
	const cancelLater = () => {
		if (later) clearTimeout(later);
		later = undefined;
		laterItems = undefined;
	};
	const start = () => {
		if (running || failed || !latest) return;
		running = (async () => {
			while (latest) {
				const snapshot = latest;
				latest = undefined;
				await write(snapshot);
			}
		})()
			.catch((error: unknown) => {
				failed = true;
				failure = error;
				latest = undefined;
				onFailure(error);
			})
			.finally(() => {
				running = undefined;
				start();
			});
	};
	const offer = (items: readonly SessionItem[]) => {
		if (failed) throw failure;
		cancelLater();
		latest = items;
		start();
	};
	return {
		offer,
		/**
		 * Offers `items` once `delayMs` has passed, unless an offer, a supersede
		 * or a drain comes first: a stream throttled to one write per window
		 * still shows its last deltas when the window ends, not at its next
		 * event (a tool call can be followed by seconds of silence).
		 */
		offerLater(items: readonly SessionItem[], delayMs: number) {
			if (failed) throw failure;
			laterItems = items;
			later ??= setTimeout(
				() => {
					const items = laterItems;
					later = undefined;
					laterItems = undefined;
					if (items && !failed) offer(items);
				},
				Math.max(0, delayMs),
			);
		},
		/**
		 * Drops a snapshot not yet being written: the caller is about to write
		 * newer items itself (a checkpoint), so writing it first is wasted.
		 */
		supersede() {
			cancelLater();
			latest = undefined;
		},
		/** Every caller writes the newest items itself next, or already saved them. */
		async drain() {
			cancelLater();
			while (running) await running;
			if (failed) throw failure;
		},
	};
}
