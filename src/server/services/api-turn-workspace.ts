import { Effect, Either } from "effect";
import { MachineNotResponding } from "#/domain/api-turn-failure";
import { guestMetadataBlockCommand } from "#/domain/guest-network-guard";
import { WorkspaceId } from "#/domain/ids";
import {
	type ProjectCheckout,
	projectCheckoutPath,
} from "#/domain/project-checkout";
import { isGeneratedSessionBranch } from "#/domain/session-branch";
import { sharesParentMachine } from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
} from "../adapters/agent-sessions";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { templateCheckoutCommit } from "../adapters/prepared-checkout";
import {
	bindAgentSessionMachine,
	bindPreparedAgentTaskMachine,
} from "./agent-session-machine";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { startFreshMachineInstall } from "./fresh-machine-setup";
import { detachedFromTurn } from "./machine-call-signal";
import {
	checkoutGitHubReads,
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
		 * A new chat (no machine yet) learns the commit its checkout will hold
		 * before its VM is ready, so an early first request can decide on that
		 * commit's hook configuration: starting its own branch, it pins the
		 * commit that branch starts from; on the branch its project template
		 * holds, it is the template's commit (the copy keeps that checkout).
		 */
		pinNewChatBase?: boolean;
		/** Reports each preparation phase as it is reached (the step's timing line). */
		onPhase?: (
			phase:
				| "workspaceBound"
				| "workspaceRunning"
				| "checkoutPrepared"
				| "baselinesSet",
		) => void;
	} = {},
) {
	let prepared: Promise<AgentToolWorkspace> | undefined;
	// The checkout and its path, known before the baselines are set.
	let checkedOut: ((ready: AgentToolWorkspace) => void) | undefined;
	const checkedOutEarly = new Promise<AgentToolWorkspace>((resolve) => {
		checkedOut = resolve;
	});
	let pinnedBase: Promise<string | null> = Promise.resolve(null);
	/** Whether the checkout must land on pinnedBase (a new branch), not only holds it. */
	let pinsCheckout: Promise<boolean> = Promise.resolve(false);
	let pinnedReads: ReturnType<typeof checkoutGitHubReads> | null = null;
	let plannedDirectory: Promise<string | null> = Promise.resolve(null);
	const workspace = () => {
		signal.throwIfAborted();
		prepared ??= reusedOrPrepared();
		return prepared;
	};
	return Object.assign(workspace, {
		/**
		 * The checked-out workspace as soon as its repository and path are
		 * ready (the guest's metadata already blocked), before the step's
		 * verification baselines are set; the whole preparation's failure
		 * otherwise. Work that neither changes the repository's HEAD, index or
		 * files nor depends on the baseline (the conversation's code point,
		 * attachments and secrets outside the repository, ~/memory) starts
		 * here, beside the baselines.
		 */
		checkedOut: (): Promise<AgentToolWorkspace> => {
			const whole = workspace();
			whole.then(checkedOut, () => {});
			return Promise.race([checkedOutEarly, whole]);
		},
		/**
		 * The commit this preparation's checkout and baseline will be, known
		 * before the VM is ready; null unless it was pinned (see pinNewChatBase).
		 * Read after the workspace was started.
		 */
		pinnedBase: () => pinnedBase,
		/**
		 * Where a fresh copy of the project template holds the repository
		 * (`$HOME/<name>`, as the environment build and the clone place it),
		 * known before the VM is ready; null unless pinNewChatBase applies.
		 * Read after the workspace was started.
		 */
		plannedDirectory: () => plannedDirectory,
		/**
		 * A file of the repository at the pinned base, read from GitHub before
		 * the VM is ready; null unless `revision` is that pinned base, or when
		 * GitHub cannot say. See repositoryFileAtCommit.
		 */
		pinnedBaseFile: async (revision: string, path: string) => {
			const reads = pinnedReads;
			if (!reads || revision !== (await pinnedBase)) return null;
			return reads.fileAt(revision, path).catch(() => null);
		},
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
			const fresh = earlyCheckout.then((planned) =>
				Either.isRight(planned) ? planned.right : null,
			);
			const newBranch = fresh.then(
				(planned) => !!planned && startsNewChatBranch(planned),
			);
			pinsCheckout = newBranch.catch(() => false);
			pinnedBase = fresh
				.then(async (planned) => {
					if (!planned) return null;
					if (await newBranch) {
						const reads = checkoutGitHubReads(planned);
						pinnedReads = reads;
						return reads.baseRevision();
					}
					if (!keepsTemplateCheckout(planned)) return null;
					const commit = await templateCheckoutCommit(
						owner.userId,
						owner.id,
						planned.fullName,
						planned.workingBranch,
					);
					if (commit) pinnedReads = checkoutGitHubReads(planned);
					return commit;
				})
				.catch(() => null);
			plannedDirectory = fresh
				.then((planned) =>
					planned ? projectCheckoutPath(TEMPLATE_HOME, planned.name) : null,
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
		options.onPhase?.("workspaceBound");
		const scoped = machinesForAgentSession(machines, bound.session);
		const vm = WorkspaceId(bound.providerRef);
		signal.throwIfAborted();
		await scoped.ensureRunning(vm);
		options.onPhase?.("workspaceRunning");
		signal.throwIfAborted();
		// Cloud metadata is refused for every user on the VM, re-applied each
		// turn (a cold boot drops the rules); it overlaps the checkout.
		const metadataBlocked = blockGuestMetadata(machines, vm, signal);
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
				const pinnedRevision = (yield* Effect.promise(() => pinsCheckout))
					? yield* Effect.promise(() => pinning)
					: null;
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
		options.onPhase?.("checkoutPrepared");
		// A machine that booted without the project's template installs in the
		// background once its checkout is there; the turn does not wait.
		if (!owner.parentSessionId)
			void detachedFromTurn(() =>
				startFreshMachineInstall(
					{ machines: scoped, vm },
					{
						userId: owner.userId,
						projectId: owner.projectId,
						sessionId: owner.id,
					},
				),
			);
		signal.throwIfAborted();
		const cwd = (await scoped.readTextFile(vm, PROJECT_CWD_PATH))?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("Prepared repository path is unavailable.");
		checkedOut?.({ machines: scoped, vm, cwd });
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
		options.onPhase?.("baselinesSet");
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
				? await agentSessionMetadataForOwner(
						owner.userId,
						owner.parentSessionId,
					)
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

/**
 * A copy of the project template whose checkout the chat keeps as it is:
 * on the branch the template checked out (templateCheckoutCommit matches it),
 * ensureProjectCheckout reuses that checkout without fetching, so its HEAD
 * is the template's commit.
 */
function keepsTemplateCheckout(checkout: ProjectCheckout) {
	return !!checkout.preserveCurrentBranch && !checkout.retainExistingBranch;
}

/** The guest home the environment build and the clone resolve on product VMs. */
const TEMPLATE_HOME = "/home/ubuntu";

/** A chat's own generated branch, started from a different base branch. */
function startsNewChatBranch(checkout: ProjectCheckout) {
	return (
		!checkout.retainExistingBranch &&
		checkout.workingBranch !== checkout.branch &&
		isGeneratedSessionBranch(checkout.workingBranch) &&
		!isGeneratedSessionBranch(checkout.branch)
	);
}

/** Waits before each retry of a metadata guard the machine did not answer. */
const METADATA_GUARD_RETRY_MS = [2_000, 5_000] as const;

/**
 * Fails closed: a VM whose metadata cannot be blocked runs no turn. A guard
 * the machine did not answer (the command threw, timed out, or failed with no
 * output) is not a guard failure: the machine is woken and the guard retried
 * twice before the turn fails as "machine isn't responding". A guard that
 * ran and refused (with stderr) fails at once.
 */
export async function blockGuestMetadata(
	machines: Pick<WorkspaceMachines, "exec"> &
		Partial<Pick<WorkspaceMachines, "ensureRunning">>,
	vm: WorkspaceId,
	signal?: AbortSignal,
	retryDelays: readonly number[] = METADATA_GUARD_RETRY_MS,
) {
	let lastFailure: unknown;
	for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
		if (attempt > 0) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, retryDelays[attempt - 1]);
				signal?.addEventListener("abort", done, { once: true });
				function done() {
					clearTimeout(timer);
					signal?.removeEventListener("abort", done);
					resolve();
				}
			});
			signal?.throwIfAborted();
			await machines.ensureRunning?.(vm).catch((error: unknown) => {
				lastFailure = error;
			});
			signal?.throwIfAborted();
		}
		let result: Awaited<ReturnType<WorkspaceMachines["exec"]>>;
		try {
			result = await machines.exec(vm, guestMetadataBlockCommand(), 30_000);
		} catch (error) {
			signal?.throwIfAborted();
			lastFailure = error;
			continue;
		}
		if (result.exitCode === 0) return;
		const stderr = result.stderr.trim();
		if (stderr && result.exitCode !== 124)
			throw new Error(
				`Cloud metadata could not be blocked on this machine: ${stderr.slice(-300)}`,
			);
		lastFailure = new Error(
			`The metadata guard exited ${result.exitCode} without an answer${stderr ? `: ${stderr.slice(-200)}` : ""}.`,
		);
	}
	throw new MachineNotResponding(lastFailure);
}

/** How long a reader waits for its parent's VM (a writer's fork pauses it). */
const SHARED_PARENT_WAIT_MS = 120_000;
