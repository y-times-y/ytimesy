import type { Freestyle } from "freestyle";
import { SCRUB_MEMORY_CREDENTIAL } from "#/domain/memory-repo";
import { SCRUB_AGENT_SECRETS } from "#/domain/project-secret";

type Vm = Pick<ReturnType<Freestyle["vms"]["ref"]>, "exec">;

/** The project env file and the memory clone's token, both removed before a snapshot. */
export const SCRUB_WORKSPACE_SECRETS = `${SCRUB_AGENT_SECRETS} && { ${SCRUB_MEMORY_CREDENTIAL}; }`;

/** Deletes agent secrets before a snapshot; refuses the snapshot if that can't be proven. */
export async function scrubAgentSecrets(vm: Vm) {
	const result = await vm.exec({
		command: SCRUB_WORKSPACE_SECRETS,
		timeoutMs: 15_000,
	});
	if (result.statusCode !== 0)
		throw new Error(
			"Could not remove project secrets from the workspace; the snapshot was not taken.",
		);
}
