const CHECK_INTERVAL_MS = 5 * 60_000;
const QUIET_THRESHOLD_MS = 90_000;
const LONG_RUNNING_CHECK_MS = 3 * CHECK_INTERVAL_MS;

/** Three bounded check-ins per child turn, never a perpetual inference loop. */
export function childSupervisionSlot(
	startedAt: number,
	progressedAt: number,
	now: number,
): number | null {
	const elapsed = now - startedAt;
	if (!Number.isFinite(elapsed) || elapsed < 2 * 60_000) return null;
	if (
		elapsed < LONG_RUNNING_CHECK_MS &&
		now - progressedAt < QUIET_THRESHOLD_MS
	)
		return null;
	return Math.min(3, Math.max(1, Math.floor(elapsed / CHECK_INTERVAL_MS) + 1));
}
