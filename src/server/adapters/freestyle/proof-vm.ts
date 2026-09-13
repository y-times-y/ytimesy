import type { FirewallSpec } from "freestyle";

export const PROOF_METADATA_PURPOSE = "ytimesy-proof";
export const PROOF_SLUG_PREFIX = "ytimesy-proof";

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
