import type { FirewallSpec } from "freestyle";

export const PROOF_METADATA_PURPOSE = "ytimesy-proof";
export const PROOF_SLUG_PREFIX = "ytimesy-proof";
export const AUTH_SNAPSHOT_SLUG_PREFIX = "ytimesy-codex-auth";

export const PROOF_LOGIN_LIFETIME = {
	ttlSeconds: 45 * 60,
	idleTimeoutSeconds: -1,
} as const;

export const GUEST_INTERNET_FIREWALL = {
	rules: [
		{
			action: "allow",
			source: {},
			destination: { public: true },
		},
	],
} satisfies FirewallSpec;

export function proofWorkspaceSlug(uniqueSuffix: string): string {
	return `${PROOF_SLUG_PREFIX}-${uniqueSuffix}`;
}

export function proofAuthSnapshotSlug(uniqueSuffix: string): string {
	return `${AUTH_SNAPSHOT_SLUG_PREFIX}-${uniqueSuffix}`;
}

export function proofCreateVmFields(input: {
	readonly slug: string;
	readonly ttlSeconds?: number;
	readonly idleTimeoutSeconds?: number;
	readonly snapshotId?: string;
}) {
	return {
		slug: input.slug,
		displayName: "ytimesy workspace proof",
		firewall: GUEST_INTERNET_FIREWALL,
		metadata: { purpose: PROOF_METADATA_PURPOSE },
		ttlSeconds: input.ttlSeconds ?? 20 * 60,
		idleTimeoutSeconds: input.idleTimeoutSeconds ?? 10 * 60,
		...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
	};
}

export function requestedAuthSnapshotId(
	snapshotId: string | undefined,
): string | null {
	return snapshotId ?? null;
}

export function privateCodexAuthSnapshotFields(uniqueSuffix: string) {
	return {
		slug: proofAuthSnapshotSlug(uniqueSuffix),
		displayName: "ytimesy isolated Codex ChatGPT login",
		autoDeleteSeconds: -1,
	};
}
