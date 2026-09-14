import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

export const WORKSPACE_METADATA_PURPOSE = "ytimesy-workspace";
export const FREESTYLE_EXEC_TIMEOUT_MS_MAX = 300_000;

export function productCreateVmFields(input: {
	readonly slug: string;
	readonly snapshotId?: string;
}) {
	return {
		slug: input.slug,
		displayName: "ytimesy workspace",
		firewall: GUEST_INTERNET_FIREWALL,
		metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
		idleTimeoutSeconds: -1,
		...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
	};
}

export function freestyleExecTimeoutMs(requestedMs: number) {
	return Math.min(Math.max(1, requestedMs), FREESTYLE_EXEC_TIMEOUT_MS_MAX);
}
