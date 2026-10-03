/** Bounded model work lives beyond HTTP requests and is tracked until graceful drain. */
export class TurnDispatcher<T> {
	private readonly active = new Set<Promise<void>>();
	private claiming: Promise<void> | null = null;
	private wakeRequested = false;
	private draining = false;
	constructor(
		private readonly input: {
			concurrency: number;
			claim: () => Promise<T | null>;
			run: (turn: T) => Promise<void>;
			onError: (error: unknown) => void;
		},
	) {
		if (
			!Number.isInteger(input.concurrency) ||
			input.concurrency < 1 ||
			input.concurrency > 32
		)
			throw new Error("Invalid model worker concurrency.");
	}
	wake() {
		if (this.draining) return;
		this.wakeRequested = true;
		if (this.claiming) return;
		this.claiming = this.fill()
			.catch(this.input.onError)
			.finally(() => {
				this.claiming = null;
				if (this.wakeRequested && !this.draining) this.wake();
			});
	}
	private async fill() {
		while (!this.draining && this.active.size < this.input.concurrency) {
			this.wakeRequested = false;
			const turn = await this.input.claim();
			if (!turn) {
				if (this.wakeRequested) continue;
				return;
			}
			const work = Promise.resolve()
				.then(() => this.input.run(turn))
				.catch(this.input.onError)
				.finally(() => {
					this.active.delete(work);
					this.wake();
				});
			this.active.add(work);
		}
		this.wakeRequested = false;
	}
	async drain() {
		this.draining = true;
		await this.claiming;
		// A turn admitted while shutdown began is still owned and must finish safely.
		await Promise.allSettled([...this.active]);
	}
}
