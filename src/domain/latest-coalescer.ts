/**
 * Coalesces a stream of "latest state" values (a turn's progress items) into
 * at most one send per `everyMs`: the first value goes out at once, later
 * ones replace each other and the newest goes out when the window ends. The
 * values are cumulative snapshots, so dropping the older ones loses nothing.
 * One send is in flight at a time.
 */
export class LatestCoalescer<T> {
	private pending: { value: T } | null = null;
	private lastSentAt = Number.NEGATIVE_INFINITY;
	private timer: unknown = null;
	private sending: Promise<void> | null = null;
	private closed = false;

	constructor(
		private readonly send: (value: T) => Promise<void> | void,
		private readonly options: {
			readonly everyMs: number;
			readonly now?: () => number;
			readonly setTimer?: (run: () => void, ms: number) => unknown;
			readonly clearTimer?: (timer: unknown) => void;
			readonly onError?: (error: unknown) => void;
		},
	) {}

	private now() {
		return (this.options.now ?? Date.now)();
	}

	push(value: T) {
		if (this.closed) return;
		this.pending = { value };
		this.schedule();
	}

	private schedule() {
		if (this.timer !== null || this.sending) return;
		const wait = Math.max(
			0,
			this.lastSentAt + this.options.everyMs - this.now(),
		);
		if (wait === 0) {
			void this.drain();
			return;
		}
		this.timer = (this.options.setTimer ?? ((run, ms) => setTimeout(run, ms)))(
			() => {
				this.timer = null;
				void this.drain();
			},
			wait,
		);
	}

	private drain(): Promise<void> {
		if (this.sending) return this.sending;
		const next = this.pending;
		if (!next) return Promise.resolve();
		this.pending = null;
		this.lastSentAt = this.now();
		this.sending = (async () => {
			try {
				await this.send(next.value);
			} catch (error) {
				this.options.onError?.(error);
			} finally {
				this.sending = null;
				if (this.pending && !this.closed) this.schedule();
			}
		})();
		return this.sending;
	}

	/** Sends what is pending now (before a checkpoint or the finish) and waits for it. */
	async flush() {
		if (this.timer !== null) {
			(this.options.clearTimer ?? ((t) => clearTimeout(t as never)))(
				this.timer,
			);
			this.timer = null;
		}
		await this.sending;
		await this.drain();
	}

	/** Drops what is pending (a newer write superseded it) but keeps sending later values. */
	discard() {
		this.pending = null;
	}

	/** Drops what is pending: the turn ended, nothing later may be sent. */
	close() {
		this.closed = true;
		this.pending = null;
		if (this.timer !== null) {
			(this.options.clearTimer ?? ((t) => clearTimeout(t as never)))(
				this.timer,
			);
			this.timer = null;
		}
	}
}
