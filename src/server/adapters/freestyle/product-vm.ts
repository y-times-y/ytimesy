import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

export const WORKSPACE_METADATA_PURPOSE = "ytimesy-workspace";
export const FREESTYLE_EXEC_TIMEOUT_MS_MAX = 300_000;

/** Pause after this long with no public/terminal traffic. -1 keeps the meter running. */
export const PRODUCT_IDLE_TIMEOUT_SECONDS = 180;

/** Smallest real Ubuntu image. Copies from a 4 vCPU snapshot stay 4 vCPU; resize cannot shrink. */
export const CHEAP_BASE_SNAPSHOT = "freestyle/ubuntu-sm";

export function productIdleTimeoutNeedsUpdate(
	current: number | null | undefined,
) {
	return current !== PRODUCT_IDLE_TIMEOUT_SECONDS;
}

export function productCreateVmFields(input: {
	readonly slug: string;
	readonly snapshotId?: string;
}) {
	return {
		slug: input.slug,
		displayName: "ytimesy workspace",
		firewall: GUEST_INTERNET_FIREWALL,
		metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
		idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
		snapshotId: input.snapshotId ?? CHEAP_BASE_SNAPSHOT,
	};
}

export function freestyleExecTimeoutMs(requestedMs: number) {
	return Math.min(Math.max(1, requestedMs), FREESTYLE_EXEC_TIMEOUT_MS_MAX);
}
