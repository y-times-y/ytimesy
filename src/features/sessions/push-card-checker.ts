import type { PushCardState } from "#/domain/push-approval";

/** How often a pending push card asks the server again while its tab is visible. */
export const PUSH_CARD_RECHECK_MS = 30_000;

/**
 * Keeps a pending push card honest: it asks the server for the card's state
 * now, whenever the chat changes after it (`check`), and on a slow interval
 * while the tab is visible, until the card is settled. One call at a time;
 * a change that arrives during a call asks again right after it.
 */
export function createPushCardChecker(input: {
	status(): Promise<PushCardState>;
	onState(state: PushCardState): void;
	/** Optional observer for background status checks; they do not block approval. */
	onChecking?(checking: boolean): void;
	visible(): boolean;
	/** Null: no interval (the user's hub signals changes; `check` is called then). */
	intervalMs?: number | null;
	timers?: {
		repeat(run: () => void, ms: number): unknown;
		clear(handle: unknown): void;
	};
}) {
	const timers = input.timers ?? {
		repeat: (run: () => void, ms: number) => setInterval(run, ms),
		clear: (handle: unknown) =>
			clearInterval(handle as ReturnType<typeof setInterval>),
	};
	let settled = false;
	let stopped = false;
	let inFlight = false;
	let again = false;
	let handle: unknown;

	async function check(): Promise<void> {
		if (settled || stopped) return;
		if (inFlight) {
			again = true;
			return;
		}
		inFlight = true;
		input.onChecking?.(true);
		try {
			const state = await input.status();
			if (stopped || settled) return;
			input.onState(state);
			if (state.answer !== "pending") {
				settled = true;
				timers.clear(handle);
			}
		} catch {
			// The next change or interval asks again.
		} finally {
			inFlight = false;
			if (!stopped) input.onChecking?.(false);
		}
		if (again && !settled && !stopped) {
			again = false;
			await check();
		}
	}

	return {
		/** Checks now and starts the interval (unless there is none). */
		start() {
			if (input.intervalMs !== null)
				handle = timers.repeat(() => {
					if (input.visible()) void check();
				}, input.intervalMs ?? PUSH_CARD_RECHECK_MS);
			return check();
		},
		check,
		/** The card was answered some other way (a click); no more checks. */
		settle() {
			settled = true;
			timers.clear(handle);
		},
		stop() {
			stopped = true;
			timers.clear(handle);
		},
	};
}
