import type { Freestyle } from "freestyle";
import { SCRUB_MACHINE_GIT_CREDENTIAL } from "#/domain/machine-git";
import { SCRUB_MEMORY_CREDENTIAL } from "#/domain/memory-repo";
import { SCRUB_AGENT_SECRETS } from "#/domain/project-secret";

type Vm = Pick<ReturnType<Freestyle["vms"]["ref"]>, "exec">;

/** The chat's own short-lived tokens: the memory clone's and plain git's. */
export const SCRUB_VM_TOKENS = `{ ${SCRUB_MEMORY_CREDENTIAL}; } && { ${SCRUB_MACHINE_GIT_CREDENTIAL}; }`;

/** The project env file and the chat's tokens, all removed before a snapshot. */
export const SCRUB_WORKSPACE_SECRETS = `${SCRUB_AGENT_SECRETS} && ${SCRUB_VM_TOKENS}`;

/**
 * The scrub is often the first command on a stopped VM, so its budget covers
 * a cold boot: 15 s timed out on every stopped workspace in production
 * (2026-11-03), and recycling never got past them.
 */
export const SCRUB_TIMEOUT_MS = 90_000;

/** Deletes agent secrets before a snapshot; refuses the snapshot if that can't be proven. */
export async function scrubAgentSecrets(vm: Vm) {
	const result = await vm.exec({
		command: SCRUB_WORKSPACE_SECRETS,
		timeoutMs: SCRUB_TIMEOUT_MS,
	});
	if (result.statusCode === 0) return;
	// No exit status: the command never finished (a boot slower than the budget).
	throw new Error(
		result.statusCode == null
			? "Removing project secrets from the workspace timed out; the snapshot was not taken."
			: "Could not remove project secrets from the workspace; the snapshot was not taken.",
	);
}
