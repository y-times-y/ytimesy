import { WorkspaceId } from "#/domain/ids";
import type { CodexRuntime, WorkspaceMachines } from "./workspace-machines";

/** Read paths never provision or wake compute. Production adapters supply the isolated runner capability. */
export async function codexRuntimeForSession(
	machines: WorkspaceMachines,
	session: { userId: string; id: string; providerRef: string },
	provision = false,
): Promise<CodexRuntime> {
	const executorId = WorkspaceId(session.providerRef);
	const runtime = await machines.codexRuntime?.({
		userId: session.userId,
		sessionId: session.id,
		executorId,
		executorMachines: machines,
		provision,
	});
	if (runtime) return runtime;
	if (provision && machines.codexRuntime)
		throw new Error("The isolated Codex runner is unavailable.");
	return { machines, workspaceId: executorId, root: "/tmp" };
}
