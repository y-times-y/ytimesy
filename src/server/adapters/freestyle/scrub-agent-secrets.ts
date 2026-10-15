import type { Freestyle } from "freestyle";
import { SCRUB_AGENT_SECRETS } from "#/domain/project-secret";

type Vm = Pick<ReturnType<Freestyle["vms"]["ref"]>, "exec">;

/** Deletes the project env file before a snapshot; refuses the snapshot if that can't be proven. */
export async function scrubAgentSecrets(vm: Vm) {
	const result = await vm.exec({
		command: SCRUB_AGENT_SECRETS,
		timeoutMs: 15_000,
	});
	if (result.statusCode !== 0)
		throw new Error(
			"Could not remove project secrets from the workspace; the snapshot was not taken.",
		);
}
