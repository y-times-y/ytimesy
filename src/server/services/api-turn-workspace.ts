import { Effect, Either } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { sharesParentMachine } from "#/domain/subagent";
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
import type { TurnWorkspaceReuse } from "./turn-workspace-reuse";
import { establishVerificationBaselines } from "./verification-baseline";
import type { WorkspaceMachines } from "./workspace-machines";

/** Only repository-backed tool execution waits for a VM; model and coordination tools do not. */
export function deferredApiTurnWorkspace(
	machines: WorkspaceMachines,
	owner: AgentSessionRecord,
	signal: AbortSignal,
	ancestors: readonly string[] = [],
	/** A durable step reuses its turn's earlier preparation; see turnWorkspaceReuse. */
	reuse?: TurnWorkspaceReuse,
) {
	let prepared: Promise<AgentToolWorkspace> | undefined;
	return () => {
		signal.throwIfAborted();
		prepared ??= reusedOrPrepared();
		return prepared;
	};
	async function reusedOrPrepared(): Promise<AgentToolWorkspace> {
		const earlier = reuse?.read();
		if (earlier)
			return {
				machines: machinesForAgentSession(machines, earlier.session),
				vm: earlier.vm,
				cwd: earlier.cwd,
			};
		const { workspace, session } = await prepare();
		reuse?.save({ session, vm: workspace.vm, cwd: workspace.cwd });
		return workspace;
	}
	async function prepare(): Promise<{
		workspace: AgentToolWorkspace;
		session: AgentSessionRecord;
	}> {
		let additionalRepositoryNames: string[] = [];
		if (ancestors.includes(owner.id) || ancestors.length > 8)
			throw new Error("Invalid shared task ancestry.");
		const checkoutScope = {
			userId: owner.userId,
			projectId: owner.projectId,
			sessionId: owner.id,
		};
		// A root chat's checkout plan (project, branch and GitHub reads) does not
		// depend on its VM, so it loads while the VM is bound and started. Its
		// outcome, failure included, is used exactly where it was loaded before.
		const earlyCheckout = owner.parentSessionId
			? undefined
			: Effect.runPromise(
					Effect.either(loadTenantProjectCheckout(checkoutScope)),
				);
		earlyCheckout?.catch(() => {});
		if (sharesParentMachine(owner)) {
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
		const bound = owner.parentSessionId
			? await bindPreparedAgentTaskMachine(
					machinesForAgentSession(machines, owner),
					{
						userId: owner.userId,
						projectId: owner.projectId,
						task: owner,
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
		if (!sharesParentMachine(bound.session))
			await Effect.runPromise(
				Effect.gen(function* () {
					const checkout = earlyCheckout
						? yield* Either.match(yield* Effect.promise(() => earlyCheckout), {
								onLeft: Effect.fail,
								onRight: Effect.succeed,
							})
						: yield* loadTenantProjectCheckout(checkoutScope);
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
		const baselines = () =>
			establishVerificationBaselines({
				machines: scoped,
				vm,
				cwd,
				userId: owner.userId,
				sessionId: owner.id,
				additionalRepositoryNames,
			});
		// A writer subagent's patch is measured from its pinned baseline.
		if (bound.session.agentRole === "writer") await baselines();
		// A root chat commits and publishes without that gate (turn-commit.ts);
		// its baseline only scopes lifecycle hooks, so a chat whose checkout was
		// already edited before baselines existed keeps working without one.
		else if (!bound.session.parentSessionId)
			await baselines().catch((error) => {
				signal.throwIfAborted();
				console.warn("Chat verification baseline unavailable.", {
					message:
						error instanceof Error ? error.message.slice(0, 200) : "unknown",
				});
			});
		return { workspace: { machines: scoped, vm, cwd }, session: bound.session };
	}
}
