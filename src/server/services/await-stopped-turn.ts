export async function awaitStoppedTurn(
	readStatus: () => Promise<string | undefined>,
	timeoutMs = 15000,
) {
	const deadline = Date.now() + timeoutMs;
	while ((await readStatus()) === "running") {
		if (Date.now() >= deadline)
			throw new Error(
				"The current turn is still stopping. Retry wrap-up when it settles; no second turn was started.",
			);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}
