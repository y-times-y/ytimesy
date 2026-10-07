import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import {
	bindAgentSessionMachine,
	bindPreparedAgentTaskMachine,
} from "./agent-session-machine";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	ensureProjectCheckout,
	loadTenantProjectCheckout,
} from "./project-workspace";
import { machinesForAgentSession } from "./session-workspace-machines";
import { establishVerificationBaselines } from "./verification-baseline";
import type { WorkspaceMachines } from "./workspace-machines";

/** Only repository-backed tool execution waits for a VM; model and coordination tools do not. */
export function deferredApiTurnWorkspace(
	machines: WorkspaceMachines,
	owner: AgentSessionRecord,
	signal: AbortSignal,
	ancestors: readonly string[] = [],
) {
	let prepared: Promise<AgentToolWorkspace> | undefined;
	return () => {
		signal.throwIfAborted();
		prepared ??= prepare();
		return prepared;
	};
	async function prepare(): Promise<AgentToolWorkspace> {
		let additionalRepositoryNames: string[] = [];
		if (ancestors.includes(owner.id) || ancestors.length > 8)
			throw new Error("Invalid shared task ancestry.");
		if (owner.taskPlacement === "shared") {
			const parent = owner.parentSessionId
				? await agentSessionForOwner(owner.userId, owner.parentSessionId)
				: null;
			if (!parent || parent.projectId !== owner.projectId)
				throw new Error("The shared parent task is unavailable.");
			await deferredApiTurnWorkspace(machines, parent, signal, [
				...ancestors,
				owner.id,
			])();
		}
		signal.throwIfAborted();
		const predecessor = owner.dependsOnSessionId
			? await agentSessionForOwner(owner.userId, owner.dependsOnSessionId)
			: null;
		if (predecessor && predecessor.projectId !== owner.projectId)
			throw new Error("The stacked predecessor is unavailable.");
		const bound = owner.taskPlacement
			? await bindPreparedAgentTaskMachine(
					machinesForAgentSession(machines, owner),
					{
						userId: owner.userId,
						projectId: owner.projectId,
						task: owner,
						predecessor,
					},
				)
			: await bindAgentSessionMachine(machines, {
					userId: owner.userId,
					projectId: owner.projectId,
					sessionId: owner.id,
					harness: owner.harness,
				});
		const scoped = machinesForAgentSession(machines, bound.session);
		const vm = WorkspaceId(bound.providerRef);
		signal.throwIfAborted();
		await scoped.ensureRunning(vm);
		signal.throwIfAborted();
		if (bound.session.taskPlacement !== "shared")
			await Effect.runPromise(
				Effect.gen(function* () {
					const checkout = yield* loadTenantProjectCheckout({
						userId: owner.userId,
						projectId: owner.projectId,
						sessionId: owner.id,
					});
					additionalRepositoryNames = (
						checkout?.additionalRepositories ?? []
					).map((repo) => repo.name);
					yield* ensureProjectCheckout(scoped, vm, checkout);
				}),
			);
		signal.throwIfAborted();
		const cwd = (await scoped.readTextFile(vm, PROJECT_CWD_PATH))?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("Prepared repository path is unavailable.");
		if (
			bound.session.taskPlacement !== "shared" &&
			bound.session.taskAccess !== "read_only"
		)
			await establishVerificationBaselines({
				machines: scoped,
				vm,
				cwd,
				userId: owner.userId,
				sessionId: owner.id,
				additionalRepositoryNames,
			});
		return { machines: scoped, vm, cwd };
	}
}
