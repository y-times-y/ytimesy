export function workedLabel(
	timing: { startedAt: number; completedAt?: number } | undefined,
): string {
	if (!timing || timing.completedAt === undefined) return "Worked";
	const seconds = Math.round((timing.completedAt - timing.startedAt) / 1000);
	if (!Number.isFinite(seconds) || seconds <= 0) return "Worked";
	return seconds < 60
		? `Worked for ${seconds}s`
		: `Worked for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
