export type OmpBuilderArm = {
	pair: number;
	arm: "before" | "after";
};

export function ompBuilderProtocol(repetitions: number) {
	if (repetitions !== 1 && repetitions !== 3)
		throw new Error("Builder proof requires one or three matched pairs.");
	const arms: OmpBuilderArm[] = [];
	for (let pair = 1; pair <= repetitions; pair++) {
		const order =
			pair % 2
				? (["before", "after"] as const)
				: (["after", "before"] as const);
		for (const arm of order) arms.push({ pair, arm });
	}
	return {
		repetitions,
		arms,
		model: "gpt-6.1-sol",
		reasoning: "low",
		requestsPerArm: 10,
		requestLimit: repetitions * 20,
		maxOutputTokens: 6000,
		armTimeoutMs: 200000,
		vmLifetimeSeconds: 1800,
		vmDollars: 5,
		approval: `5-usd-${repetitions * 20}-requests`,
	};
}
