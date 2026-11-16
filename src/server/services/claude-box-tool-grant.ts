import type { WorkspaceId } from "#/domain/ids";
import {
	vmRedactionProbe,
	vmRedactionReady,
} from "#/domain/vm-secret-redaction";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * The per-run grant that lets a Claude runner box run the chat's workspace
 * tools itself, straight against the chat's VM, instead of each call waking
 * the chat's Durable Object (docs/claude-code-placement.md, "Workspace tools
 * on the box"). The edge holds every secret: it starts the VM (an identity
 * cannot), mints a Freestyle identity that may only run commands on that VM
 * as its default Linux user, and gives the box only that identity's token.
 *
 * The identity's id is kept on the turn (api_turn.box_tool_identity) from
 * before it is granted anything, and deleted at turn end, lease loss and VM
 * replacement (releaseClaudeBoxToolIdentity), or by the sweep for turns that
 * stopped running (sweepClaudeBoxToolIdentities). Every failure here leaves
 * the run on the edge's tools, as before: it never fails the turn.
 */
export type BoxToolIdentityStore = {
	/** The identity the turn holds now, if any. */
	readonly current: () => Promise<string | null>;
	/** Records a new identity while this step owns the running turn; false otherwise. */
	readonly record: (identityId: string) => Promise<boolean>;
	/** Forgets `identityId` once it was deleted (only if the turn still names it). */
	readonly clear: (identityId: string) => Promise<void>;
};

export type ClaudeBoxToolGrant = {
	readonly vmId: string;
	readonly linuxUser: string;
	/** The identity's token: never logged, only written to the run's input file. */
	readonly token: string;
	/** The box's commands have their output redacted on the VM (vm-secret-redaction.ts). */
	readonly redactOnVm?: true;
};

/** A Linux user name as `id -un` prints it. */
const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function failureText(error: unknown) {
	return error instanceof Error ? error.message.slice(0, 200) : "unknown";
}

/** Deletes the turn's identity, if it holds one, then forgets it. Throws when the delete fails (the id stays for the sweep). */
async function revokeCurrent(
	identities: NonNullable<WorkspaceMachines["boxToolIdentities"]>,
	store: BoxToolIdentityStore,
) {
	const current = await store.current();
	if (!current) return;
	await identities.revoke(current);
	await store.clear(current);
}

/**
 * The grant for a run about to launch, or null: the provider has no
 * identities, a previous identity could not be deleted, the VM did not
 * start, the mint failed, or the turn has runtime secrets (`redactOnVm`)
 * and the VM cannot redact them itself (no readable env file naming them,
 * no python3): their values never go to the box, so the edge serves the
 * tools and redacts as before.
 */
export async function grantClaudeBoxTools(input: {
	readonly machines: WorkspaceMachines;
	readonly vm: WorkspaceId;
	readonly store: BoxToolIdentityStore;
	readonly redactOnVm?: boolean;
	/** Tests only: the VM's env file (AGENT_SECRETS_ENV_PATH otherwise). */
	readonly envPath?: string;
}): Promise<ClaudeBoxToolGrant | null> {
	const identities = input.machines.boxToolIdentities;
	if (!identities) return null;
	try {
		// One identity per run: the previous run's (same turn) goes first, so
		// no token outlives the run it was minted for.
		await revokeCurrent(identities, input.store);
		// Identity requests are not run as background requests: a paused or
		// stopped VM must be running before the box calls it.
		const vm = await input.machines.ensureRunning(input.vm);
		const probe = await input.machines.exec(vm, "id -un", 30_000);
		const linuxUser = probe.stdout.trim();
		if (probe.exitCode !== 0 || !LINUX_USER.test(linuxUser))
			throw new Error("the VM's default Linux user could not be read");
		if (
			input.redactOnVm &&
			!vmRedactionReady(
				await input.machines.exec(vm, vmRedactionProbe(input.envPath), 30_000),
			)
		)
			throw new Error("the VM cannot redact the project's secrets itself");
		const grant = await identities.mint(vm, linuxUser, input.store.record);
		if (!grant) return null;
		return {
			vmId: vm,
			linuxUser,
			token: grant.token,
			...(input.redactOnVm ? { redactOnVm: true as const } : {}),
		};
	} catch (error) {
		console.warn("Claude box tools were not granted; the edge serves them.", {
			vm: input.vm,
			message: failureText(error),
		});
		return null;
	}
}

/**
 * Deletes the turn's identity at turn end, lease loss, failover or VM
 * replacement. Never throws: a failed delete leaves the id for the sweep.
 */
export async function releaseClaudeBoxToolIdentity(input: {
	readonly machines: WorkspaceMachines;
	readonly store: BoxToolIdentityStore;
}): Promise<void> {
	const identities = input.machines.boxToolIdentities;
	if (!identities) return;
	await revokeCurrent(identities, input.store).catch((error: unknown) =>
		console.warn(
			"A Claude box tool identity was not deleted; the sweep will.",
			{
				message: failureText(error),
			},
		),
	);
}

/**
 * The cron's sweep: deletes the identities of turns that are no longer
 * running (settled, or their lease lapsed), whatever stopped their step from
 * doing it. Returns how many were deleted; one failing does not stop the rest.
 */
export async function sweepClaudeBoxToolIdentities(input: {
	readonly machines: WorkspaceMachines;
	readonly stale: () => Promise<
		readonly { turnId: string; identityId: string }[]
	>;
	readonly clear: (turnId: string, identityId: string) => Promise<void>;
}): Promise<number> {
	const identities = input.machines.boxToolIdentities;
	if (!identities) return 0;
	let deleted = 0;
	for (const { turnId, identityId } of await input.stale()) {
		try {
			await identities.revoke(identityId);
			await input.clear(turnId, identityId);
			deleted += 1;
		} catch (error) {
			console.warn("A stale Claude box tool identity was not deleted.", {
				turnId,
				message: failureText(error),
			});
		}
	}
	return deleted;
}
