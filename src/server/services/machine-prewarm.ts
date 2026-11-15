import { agentSessionMachineSlug } from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import {
	agentSessionHasItems,
	agentSessionMetadataForOwner,
} from "../adapters/agent-sessions";
import {
	claimMachinePrewarm,
	finishMachinePrewarm,
	unusedMachinePrewarms,
} from "../adapters/machine-prewarm";
import { projectMachineSize } from "../adapters/project-machine-size";
import { workspaceForProject } from "../adapters/workspaces";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Copies an empty new chat's machine from its project template while its
 * first message is typed, so the first turn finds it by its slug instead of
 * waiting 2-4 s for the copy (and its resize). The chat's row is left
 * without the machine (bindAgentSessionMachine names it), so the turn still
 * treats the copy as fresh: an early first request stays possible. The copy
 * goes through the same usage admission as any other.
 */
export async function prewarmChatMachine(
	machines: Pick<WorkspaceMachines, "provisionSession">,
	input: { userId: string; projectId: string; sessionId: string },
): Promise<"started" | "skipped"> {
	// Only whether the chat is empty is asked: its transcript is not read.
	const session = await agentSessionMetadataForOwner(
		input.userId,
		input.sessionId,
	);
	if (
		!session ||
		session.projectId !== input.projectId ||
		session.parentSessionId ||
		session.providerRef ||
		session.turnStatus === "running" ||
		(await agentSessionHasItems(input.userId, input.sessionId))
	)
		return "skipped";
	const [workspace, size] = await Promise.all([
		workspaceForProject(input.userId, input.projectId),
		projectMachineSize(input.userId, input.projectId),
	]);
	const snapshotId = workspace?.templateSnapshotId;
	if (!snapshotId) return "skipped";
	if (!(await claimMachinePrewarm(input.userId, input.sessionId)))
		return "skipped";
	try {
		const vmId = await machines.provisionSession(
			agentSessionMachineSlug(input.sessionId),
			snapshotId,
			size,
		);
		await finishMachinePrewarm(input.sessionId, { snapshotId, vmId });
	} catch (error) {
		console.warn("A new chat's machine could not be copied ahead.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		await finishMachinePrewarm(input.sessionId, { failed: true });
	}
	return "started";
}

/** Deletes copies whose chat sent nothing in time; usage settles as for any deleted VM. */
export async function sweepUnusedChatMachines(
	machines: Pick<WorkspaceMachines, "destroy">,
) {
	for (const unused of await unusedMachinePrewarms()) {
		if (unused.vm_id) await machines.destroy(WorkspaceId(unused.vm_id));
		await finishMachinePrewarm(unused.session_id, { swept: true });
	}
}
