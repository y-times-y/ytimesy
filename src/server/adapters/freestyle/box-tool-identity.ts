import { type Freestyle, FreestyleApiError } from "freestyle";

/**
 * A Freestyle identity that may run commands on one VM as one Linux user and
 * nothing else, for the Claude runner box's workspace tools
 * (docs/claude-code-placement.md, "Workspace tools on the box"). A client
 * built with its token reaches only that VM's exec and terminal routes. The
 * token never expires: deleting the identity is the only revocation, so its
 * id is recorded on the turn before it is given any permission or token, and
 * whatever is recorded is deleted at turn end or by the sweep.
 */
export type BoxToolIdentities = Pick<
	Freestyle["identities"],
	"create" | "delete"
>;

export type BoxToolGrant = {
	readonly identityId: string;
	/** Never logged or stored; the run's input file is its only copy. */
	readonly token: string;
};

/**
 * Creates the identity, has `record` store its id (false: the turn is no
 * longer this step's, and nothing is granted), grants exactly `vmId` as
 * `linuxUser`, and mints its token. On any failure after the identity exists
 * it is deleted again; when that fails too the recorded id is left for the
 * sweep (sweepClaudeBoxToolIdentities).
 */
export async function mintBoxToolIdentity(
	identities: BoxToolIdentities,
	input: {
		readonly vmId: string;
		readonly linuxUser: string;
		readonly record: (identityId: string) => Promise<boolean>;
	},
): Promise<BoxToolGrant | null> {
	const { identity, identityId } = await identities.create();
	try {
		if (!(await input.record(identityId))) {
			await revokeBoxToolIdentity(identities, identityId);
			return null;
		}
		await identity.permissions.vm.grant({
			vmId: input.vmId,
			allowedLinuxUsers: [input.linuxUser],
		});
		const { token } = await identity.tokens.create();
		return { identityId, token };
	} catch (error) {
		await revokeBoxToolIdentity(identities, identityId).catch(() => undefined);
		throw error;
	}
}

/** Deletes the identity with its grant and tokens; one already gone is fine. */
export async function revokeBoxToolIdentity(
	identities: BoxToolIdentities,
	identityId: string,
): Promise<void> {
	try {
		await identities.delete(identityId);
	} catch (error) {
		if (error instanceof FreestyleApiError && error.status === 404) return;
		throw error;
	}
}
