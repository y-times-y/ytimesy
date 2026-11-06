import type { SessionItem } from "#/domain/session-item";

/**
 * A streaming step writes its progress at most once per window; the last
 * deltas of a window still go out when it ends (offerLater), and step end,
 * turn end, stop and failure write at once.
 */
export const PROGRESS_WINDOW_MS = 1500;

/** Streams do not wait on storage; checkpoint/finalization must drain this writer first. */
export function turnProgressWriter(
	write: (items: readonly SessionItem[]) => Promise<void>,
	onFailure: (error: unknown) => void,
) {
	let latest: readonly SessionItem[] | undefined;
	let running: Promise<void> | undefined;
	let failed = false;
	let failure: unknown;
	/** Items history is replaced, never mutated, so the same array is already stored. */
	let stored: readonly SessionItem[] | undefined;
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
				if (snapshot === stored) continue;
				await write(snapshot);
				stored = snapshot;
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
	/** When a stream snapshot last went out (now, or when its window ended). */
	let streamedAt = 0;
	const offer = (items: readonly SessionItem[]) => {
		if (failed) throw failure;
		cancelLater();
		latest = items;
		start();
	};
	return {
		offer,
		/** A checkpoint stored `items` with the model history, so writing them again is wasted. */
		markStored(items: readonly SessionItem[]) {
			stored = items;
		},
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
					if (items && !failed) {
						streamedAt = Date.now();
						offer(items);
					}
				},
				Math.max(0, delayMs),
			);
		},
		/**
		 * Stream deltas: writes at once when `windowMs` has passed since the
		 * last stream write, else when the window ends, so at most one write
		 * per window and the newest delta is never older than the window.
		 */
		stream(items: readonly SessionItem[], windowMs: number) {
			const wait = streamedAt + windowMs - Date.now();
			if (wait <= 0) {
				streamedAt = Date.now();
				offer(items);
			} else this.offerLater(items, wait);
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
