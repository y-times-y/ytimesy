/**
 * Waits for `work` for at most `ms`, then stops waiting (the work itself is not
 * cancelled). Best-effort tails of a Durable Object invocation use it: the
 * object is billed for every second its alarm or request has not returned, and
 * a hung tail once held a finished turn's alarm open for 6-14 minutes.
 */
export async function boundedWait(
	work: Promise<unknown>,
	ms: number,
	onTimeout?: () => void,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<"limit">((resolve) => {
		timer = setTimeout(() => resolve("limit"), ms);
	});
	try {
		const outcome = await Promise.race([
			work.then(
				() => "done" as const,
				() => "done" as const,
			),
			limit,
		]);
		if (outcome === "limit") onTimeout?.();
	} finally {
		clearTimeout(timer);
	}
}
