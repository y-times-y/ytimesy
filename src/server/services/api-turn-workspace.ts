import { Effect, Either } from "effect";
import { guestMetadataBlockCommand } from "#/domain/guest-network-guard";
import { WorkspaceId } from "#/domain/ids";
import type { ProjectCheckout } from "#/domain/project-checkout";
import { isGeneratedSessionBranch } from "#/domain/session-branch";
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
	checkoutBaseRevision,
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
	/** A durable step reuses its turn's earlier preparation; see turnWorkspaceReuse. */
	reuse?: TurnWorkspaceReuse,
	options: {
		/**
		 * A new chat (no machine yet) starting its own branch pins the commit
		 * that branch starts from before its VM is ready, so an early first
		 * request can decide on that commit's hook configuration.
		 */
		pinNewChatBase?: boolean;
	} = {},
) {
	let prepared: Promise<AgentToolWorkspace> | undefined;
	let pinnedBase: Promise<string | null> = Promise.resolve(null);
	const workspace = () => {
		signal.throwIfAborted();
		prepared ??= reusedOrPrepared();
		return prepared;
	};
	return Object.assign(workspace, {
		/**
		 * The commit this preparation's checkout and baseline will be, known
		 * before the VM is ready; null unless it was pinned (see pinNewChatBase).
		 * Read after the workspace was started.
		 */
		pinnedBase: () => pinnedBase,
	});
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
		if (sharesParentMachine(owner)) return attachSharedParent();
		let additionalRepositoryNames: string[] = [];
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
		// Only a chat that never had a machine gets a fresh copy of the project
		// template, where its own new branch cannot exist yet: the checkout
		// switches to it at the pinned commit, which becomes its baseline.
		if (
			earlyCheckout &&
			options.pinNewChatBase &&
			!owner.providerRef &&
			!owner.parentSessionId
		) {
			pinnedBase = earlyCheckout
				.then((planned) =>
					Either.isRight(planned) &&
					planned.right &&
					startsNewChatBranch(planned.right)
						? checkoutBaseRevision(planned.right)
						: null,
				)
				.catch(() => null);
		}
		const pinning = pinnedBase;
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
		// Cloud metadata is refused for every user on the VM, re-applied each
		// turn (a cold boot drops the rules); it overlaps the checkout.
		const metadataBlocked = blockGuestMetadata(machines, vm);
		metadataBlocked.catch(() => {});
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
				const pinnedRevision = yield* Effect.promise(() => pinning);
				yield* ensureProjectCheckout(
					scoped,
					vm,
					checkout && pinnedRevision
						? { ...checkout, pinnedRevision }
						: checkout,
				);
			}),
		);
		await metadataBlocked;
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
				// A writer subagent works on a fork of its parent's VM (never pristine).
				forkedFrom:
					owner.parentSessionId && owner.agentFork?.vmId && owner.agentFork.base
						? {
								parentSessionId: owner.parentSessionId,
								forkBase: owner.agentFork.base,
							}
						: undefined,
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
	/**
	 * A reader (or a shared writer) runs in its parent's prepared checkout and
	 * never prepares one: preparing would take the GitHub clone path whenever
	 * the parent's VM is briefly unreachable, as it is while a sibling
	 * writer's fork snapshots it. It waits, bounded, for that VM instead.
	 */
	async function attachSharedParent(): Promise<{
		workspace: AgentToolWorkspace;
		session: AgentSessionRecord;
	}> {
		const deadline = Date.now() + SHARED_PARENT_WAIT_MS;
		let pause = 250;
		let reason = "";
		for (;;) {
			signal.throwIfAborted();
			const parent = owner.parentSessionId
				? await agentSessionForOwner(owner.userId, owner.parentSessionId)
				: null;
			if (!parent || parent.projectId !== owner.projectId)
				throw new Error("The shared parent task is unavailable.");
			try {
				const bound = await bindPreparedAgentTaskMachine(
					machinesForAgentSession(machines, owner),
					{ userId: owner.userId, projectId: owner.projectId, task: owner },
				);
				const scoped = machinesForAgentSession(machines, bound.session);
				const vm = WorkspaceId(bound.providerRef);
				signal.throwIfAborted();
				await scoped.ensureRunning(vm);
				const cwd = (await scoped.readTextFile(vm, PROJECT_CWD_PATH))?.trim();
				if (cwd?.startsWith("/"))
					return {
						workspace: { machines: scoped, vm, cwd },
						session: bound.session,
					};
				reason = "its prepared repository path is not readable";
			} catch (error) {
				signal.throwIfAborted();
				reason = error instanceof Error ? error.message : String(error);
			}
			if (Date.now() + pause > deadline)
				throw new Error(
					`The parent's workspace is unavailable, so this subagent cannot attach to it (${reason.slice(0, 200)}). Retry once the parent's workspace is running.`,
				);
			await new Promise((resolve) => setTimeout(resolve, pause));
			pause = Math.min(pause * 2, 2_000);
		}
	}
}

/** A chat's own generated branch, started from a different base branch. */
function startsNewChatBranch(checkout: ProjectCheckout) {
	return (
		!checkout.retainExistingBranch &&
		checkout.workingBranch !== checkout.branch &&
		isGeneratedSessionBranch(checkout.workingBranch) &&
		!isGeneratedSessionBranch(checkout.branch)
	);
}

/** Fails closed: a VM whose metadata cannot be blocked runs no turn. */
export async function blockGuestMetadata(
	machines: Pick<WorkspaceMachines, "exec">,
	vm: WorkspaceId,
) {
	const result = await machines.exec(vm, guestMetadataBlockCommand(), 30_000);
	if (result.exitCode !== 0)
		throw new Error(
			`Cloud metadata could not be blocked on this machine: ${result.stderr.slice(-300)}`,
		);
}

/** How long a reader waits for its parent's VM (a writer's fork pauses it). */
const SHARED_PARENT_WAIT_MS = 120_000;
