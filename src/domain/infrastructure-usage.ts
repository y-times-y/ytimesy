export const MAX_USAGE_MICRO_USD = 1_000_000_000_000;

export function validUsageAmount(amount: number) {
	if (
		!Number.isSafeInteger(amount) ||
		amount < 0 ||
		amount > MAX_USAGE_MICRO_USD
	)
		throw new Error("Invalid infrastructure usage amount.");
	return amount;
}

export function utcUsageMonth(now = new Date()) {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid usage date.");
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function infrastructureBalance(input: {
	allowanceMicroUsd: number;
	consumedMicroUsd: number;
	reservedMicroUsd: number;
}) {
	for (const value of Object.values(input)) validUsageAmount(value);
	return {
		...input,
		remainingMicroUsd: Math.max(
			0,
			input.allowanceMicroUsd - input.consumedMicroUsd - input.reservedMicroUsd,
		),
	};
}
