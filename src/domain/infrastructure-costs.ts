/** Retail-rate projections, not provider invoices. No free allowances are assumed. */
export function fleetCostProjection(
	vms: readonly {
		state: string;
		resources: { cpu: number; memory: number; storage: number };
	}[],
	snapshotCount: number,
) {
	if (!Number.isSafeInteger(snapshotCount) || snapshotCount < 0)
		throw new Error("Invalid snapshot inventory.");
	let computeHourlyMicroUsd = 0;
	let storageHourlyMicroUsd = 0;
	let activeVms = 0;
	for (const vm of vms) {
		if (
			!Object.values(vm.resources).every(
				(value) => Number.isFinite(value) && value > 0,
			)
		)
			throw new Error("Unknown fleet resources.");
		storageHourlyMicroUsd += (vm.resources.storage / 1024) * 86;
		if (["starting", "running", "pausing"].includes(vm.state)) {
			activeVms++;
			computeHourlyMicroUsd +=
				vm.resources.cpu * 40320 + (vm.resources.memory / 1024) * 12900;
		}
	}
	return {
		vmCount: vms.length,
		activeVms,
		snapshotCount,
		computeHourlyMicroUsd: Math.ceil(computeHourlyMicroUsd),
		storageMonthlyMicroUsd: Math.ceil(storageHourlyMicroUsd * 24 * 30),
		snapshotChargesKnown: false,
		transferChargesKnown: false,
		invoiceVerified: false,
	};
}
