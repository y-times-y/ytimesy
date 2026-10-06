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
	return {
		offer(items: readonly SessionItem[]) {
			if (failed) throw failure;
			latest = items;
			start();
		},
		async drain() {
			while (running) await running;
			if (failed) throw failure;
		},
	};
}
