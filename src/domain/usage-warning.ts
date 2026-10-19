/** Share of the monthly cloud allowance at which users are warned. */
export const USAGE_WARNING_SHARE = 0.7;

export type UsageWarning = {
	readonly level: "warning" | "exhausted";
	readonly usedPercent: number;
	readonly message: string;
};

/**
 * Early warning before a user's cloud minutes run out. Held minutes (running
 * machines) count as used: they are what makes the next start fail.
 */
export function usageWarning(usage: {
	allowanceMicroUsd: number;
	consumedMicroUsd: number;
	reservedMicroUsd: number;
}): UsageWarning | null {
	const used = usage.consumedMicroUsd + usage.reservedMicroUsd;
	if (usage.allowanceMicroUsd <= 0 || used >= usage.allowanceMicroUsd)
		return {
			level: "exhausted",
			usedPercent: 100,
			message:
				"You have used all of this month's cloud minutes. Machines cannot start until the allowance resets on the 1st (UTC); your work is preserved.",
		};
	const share = used / usage.allowanceMicroUsd;
	if (share < USAGE_WARNING_SHARE) return null;
	const usedPercent = Math.floor(share * 100);
	return {
		level: "warning",
		usedPercent,
		message: `You have used ${usedPercent}% of this month's cloud minutes. When they run out, machines cannot start until the allowance resets on the 1st (UTC).`,
	};
}
