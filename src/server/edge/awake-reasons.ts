/**
 * What keeps a Durable Object from hibernating after its handler returns: a
 * pending ctx.waitUntil promise, an interval or timer. Cloudflare bills duration
 * while one is pending (up to 15 minutes each on compatibility dates from
 * 2026-10-01). This only counts them, so the development edge can confirm an
 * object is eligible between events (YTIMESY_DO_AWAKE_REASONS=1; counts, no data).
 */
export class PendingTracker {
	private pending = 0;
	get count() {
		return this.pending;
	}
	/** Hands `promise` to `waitUntil`, counted until it settles either way. */
	track(
		promise: Promise<unknown>,
		waitUntil: (promise: Promise<unknown>) => void,
	) {
		this.pending += 1;
		const settled = () => {
			this.pending -= 1;
		};
		waitUntil(promise.then(settled, settled));
	}
}

export function awakeReasonsEnabled(value: string | undefined) {
	return value === "1";
}
