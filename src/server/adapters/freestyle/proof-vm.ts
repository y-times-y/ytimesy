import type { FirewallSpec } from "freestyle";

export const PROOF_METADATA_PURPOSE = "ytimesy-proof";
const PROOF_SLUG_PREFIX = "ytimesy-proof";

/**
 * Egress to the public Internet and nothing else. Freestyle firewalls are
 * allow-only and default-deny, and `public: true` matches only publicly
 * routable addresses ("no public rule reaches a private address"), so private
 * ranges, link-local metadata (169.254.0.0/16), loopback and other tenants'
 * private networks stay unreachable. Inbound needs no rule: the edge delivers
 * published TLS routes regardless. Never add a `cidr`, `vpcId` or `vmId`
 * destination here without a reviewed reason.
 */
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
