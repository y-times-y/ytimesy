import { WorkspaceId } from "#/domain/ids";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import type { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import { machinesForAgentSession } from "../services/session-workspace-machines";

/**
 * Where the repository path note lives on the VM (the edge's `vm/ensure`
 * preparation writes it; same value as freestyle/clone-project's
 * PROJECT_CWD_PATH, repeated here so a box does not load that adapter).
 */
export const BOX_PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd";

/**
 * A turn runner box's `deferredApiTurnWorkspace`: it prepares nothing. The
 * chat's VM was bound, started, checked out and its guest metadata blocked
 * by the edge (`vm/ensure` runs the same `deferredApiTurnWorkspace` there,
 * with the account key), so the box only asks `machines.ensureRunning()`
 * (one `vm/ensure` per turn, then free) and reads the repository path the
 * preparation left on the VM through the scoped guest identity.
 *
 * What the edge's preparation does that this does not report back: the
 * "your workspace was replaced" note (`replacedFrom`), the pinned new-chat
 * base for an early first request (`pinnedBase`, null), and the verification
 * baselines' timing. Subagents never run on a box (they are routed away),
 * so there is no shared-parent attach.
 */
export const boxApiTurnWorkspace: typeof deferredApiTurnWorkspace = (
	machines,
	owner,
	signal,
) => {
	let prepared: Promise<AgentToolWorkspace> | undefined;
	const prepare = async (): Promise<AgentToolWorkspace> => {
		signal.throwIfAborted();
		const vm = await machines.ensureRunning(
			WorkspaceId(owner.providerRef ?? "pending"),
		);
		const scoped = machinesForAgentSession(machines, owner);
		const cwd = (await scoped.readTextFile(vm, BOX_PROJECT_CWD_PATH))?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("Prepared repository path is unavailable.");
		return { machines: scoped, vm, cwd };
	};
	const workspace = () => {
		signal.throwIfAborted();
		prepared ??= prepare();
		return prepared;
	};
	return Object.assign(workspace, {
		checkedOut: workspace,
		pinnedBase: async () => null,
		plannedDirectory: async () => null,
		pinnedBaseFile: async () => null,
	});
};
