import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	copiedSessionScratchResetCommands,
	nextAgentSessionMachineSlug,
	projectEnvironmentSnapshotSlug,
	type SessionMachinePlan,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
	shouldResealProjectSnapshotAfterCopyFailure,
	workspaceCopyCapacityRetryDelaysMs,
} from "#/domain/agent-session";
import type { AgentTaskAccess, AgentTaskPlacement } from "#/domain/agent-task";
import { failureMessage, workspaceLooksGone } from "#/domain/failure-message";
import { AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import { listedModelPreferenceFromSessions } from "#/domain/listed-model";
import { machineStartAbandoned } from "#/domain/machine-replacement";
import type { MachineSizeId } from "#/domain/machine-size";
import { sessionTitleFromText } from "#/domain/session-item";
import { sharesParentMachine } from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	childAgentSession,
	deleteAgentSessionForOwner,
	descendantAgentSessionMetadata,
	insertAgentSession,
	latestAgentSessionMetadata,
	listAgentSessions,
	listedModelBlockItemsForOwner,
	providerRefsHeldOutside,
	reusableEmptyChat,
	saveAgentSessionProviderRef,
	selectAgentSessionHarness,
} from "#/server/adapters/agent-sessions";
import { projectMachineSize } from "#/server/adapters/project-machine-size";
import { projectNetworkPolicy } from "#/server/adapters/project-network-policy";
import {
	saveTemplateSnapshot,
	workspaceForProject,
} from "#/server/adapters/workspaces";
import { chatCleanupTargets } from "../adapters/account-deletion";
import { reserveAgentTaskStart } from "../adapters/agent-capacity";
import { checkpointForSession } from "../adapters/checkpoints/records";
import {
	checkpointStorageConfigured,
	removeChatObjects,
} from "../adapters/checkpoints/storage";
import { conversationForkPending } from "../adapters/conversation-fork";
import {
	machineBudgetSpent,
	machineStartUnstartable,
} from "../adapters/freestyle/machine-failure";
import { prewarmedMachine } from "../adapters/machine-prewarm";
import { readWakeFailureStreak } from "../adapters/machine-wake-failures";
import { purgeConversationState } from "../adapters/realtime-delivery";
import { markFreshChatMachine } from "../adapters/setup-catch-up";
import { replaceHelperFork } from "../adapters/subagents";
import { workspaceBootSnapshotId } from "../records/tools-snapshot-store";
import { cancelServerTurn } from "./cancel-server-turn";
import { startEnvironmentServices } from "./environment-services";
import { detachedFromTurn } from "./machine-call-signal";
import { restoreSessionWorkspace } from "./session-checkpoint";
import { forkWriterWorkspace } from "./subagent-writer";
import { turnSpan } from "./turn-timing";
import type { WorkspaceMachines } from "./workspace-machines";

type ResolveAgentSessionInput = {
	readonly userId: string;
	readonly projectId: string;
	readonly harness: AgentProviderId;
	readonly sessionId?: string;
	readonly createNew?: boolean;
	readonly parentSessionId?: string;
	readonly title?: string;
	readonly listedModelId?: string;
	readonly task?: {
		readonly prompt: string;
		readonly placement: AgentTaskPlacement;
		readonly access: AgentTaskAccess;
	};
};

type ResolvedAgentSession<Session> = {
	session: Session;
	workspace: {
		id: string;
		providerRef: string | null;
		templateSnapshotId: string | null;
	};
};

/**
 * A chat that already exists is returned without its transcript; a new one
 * (`createNew`) is the row just inserted, transcript included.
 */
async function resolveAgentSessionRecord(
	input: ResolveAgentSessionInput & { readonly createNew: true },
): Promise<ResolvedAgentSession<AgentSessionRecord>>;
async function resolveAgentSessionRecord(
	input: ResolveAgentSessionInput,
): Promise<ResolvedAgentSession<Omit<AgentSessionRecord, "items">>>;
async function resolveAgentSessionRecord(
	input: ResolveAgentSessionInput,
): Promise<ResolvedAgentSession<Omit<AgentSessionRecord, "items">>> {
	// The named chat (and a subagent's parent) is read by id beside the
	// project's environment; the project's whole chat list is read only when
	// it is needed: to pick its latest chat, or the model a new chat inherits.
	// Both are read without their transcripts (megabytes, read at every turn
	// step); only a new chat inheriting its parent's model reads the parent's.
	const [workspace, named, parent] = await Promise.all([
		workspaceForProject(input.userId, input.projectId),
		input.sessionId && !input.createNew
			? agentSessionMetadataForOwner(input.userId, input.sessionId)
			: null,
		input.parentSessionId
			? agentSessionMetadataForOwner(input.userId, input.parentSessionId)
			: null,
	]);
	// A chat never waits for the project's environment (being built, or its
	// build failed): without a template its machine boots fresh
	// (sessionMachinePlan). Only a project with no environment record is
	// refused: the chat row needs it.
	if (!workspace) {
		throw new Error("Prepare a project environment before starting an agent.");
	}
	let listed: Promise<Omit<AgentSessionRecord, "items">[]> | undefined;
	const sessions = () => {
		listed ??= listAgentSessions(input.userId, input.projectId);
		return listed;
	};
	const selected = input.createNew
		? null
		: input.sessionId
			? named
			: input.parentSessionId
				? await childAgentSession(input.userId, input.parentSessionId)
				: ((await sessions())[0] ?? null);
	if (input.sessionId && !input.createNew && !selected) {
		throw new Error("Agent session is not available.");
	}
	if (selected && selected.projectId !== input.projectId) {
		throw new Error("Agent session is not in this project.");
	}
	if (parent && parent.projectId !== input.projectId) {
		throw new Error("The parent task is not in this project.");
	}
	const inherited =
		selected || input.listedModelId?.trim()
			? null
			: await inheritedListedModel(input.userId, input.harness, [
					...(parent ? [parent] : []),
					...(await sessions()),
				]);
	const session =
		selected ??
		(await insertAgentSession({
			userId: input.userId,
			projectId: input.projectId,
			workspaceId: workspace.id,
			harness: input.harness,
			parentSessionId: input.parentSessionId,
			title: input.title,
			listedModelId:
				input.listedModelId?.trim() || inherited?.listedModelId || null,
			task: input.task,
		}));
	return {
		session,
		workspace: {
			id: workspace.id,
			providerRef: workspace.providerRef,
			templateSnapshotId: workspace.templateSnapshotId,
		},
	};
}

/**
 * The model a new chat takes from its parent and the project's chats
 * (listedModelPreferenceFromSessions). Their transcripts are not read: only
 * what sessionListedModelIsBlocked scans, of the chats on this runtime that
 * name a model.
 */
async function inheritedListedModel(
	userId: string,
	harness: AgentProviderId,
	sessions: readonly Pick<
		AgentSessionRecord,
		"id" | "harness" | "listedModelId"
	>[],
) {
	const scanned = [
		...new Set(
			sessions
				.filter(
					(session) =>
						session.harness === harness && session.listedModelId?.trim(),
				)
				.map((session) => session.id),
		),
	];
	const items = await listedModelBlockItemsForOwner(userId, scanned);
	return listedModelPreferenceFromSessions({
		harness,
		sessions: sessions.map((session) => ({
			harness: session.harness,
			listedModelId: session.listedModelId,
			items: items.get(session.id) ?? [],
		})),
	});
}

/**
 * New chat is a session row. The VM copy waits until Connect or Send so
 * opening a composer does not consume a Freestyle slot.
 */
export async function openAgentSession(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly harness: AgentProviderId;
	readonly parentSessionId?: string;
	readonly title?: string;
	/** Opened to send this message: the chat is claimed for it in the same step. */
	readonly firstMessage?: string;
}) {
	const claimTitle =
		input.firstMessage === undefined
			? undefined
			: sessionTitleFromText(input.firstMessage);
	if (!input.parentSessionId && !input.title) {
		const empty = await reusableEmptyChat(
			input.userId,
			input.projectId,
			input.harness,
			claimTitle,
		);
		if (empty) return empty;
	}
	const { session } = await resolveAgentSessionRecord({
		...input,
		title: input.title ?? claimTitle,
		createNew: true,
	});
	return session;
}

/**
 * Creates a subagent's session row under its parent (subagent-tools.ts). The
 * tree's depth, width and budget are admitted by subagentAdmission first.
 */
export async function openAgentTask(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly parentSessionId: string;
	readonly title: string;
	readonly harness: AgentProviderId;
	readonly modelId: string;
	readonly prompt: string;
	readonly placement: AgentTaskPlacement;
	readonly access: AgentTaskAccess;
	/** Lead mode fusion's sidekick: a writer on its parent's machine (src/domain/sidekick.ts). */
	readonly sharedWriter?: boolean;
}) {
	const parent = await agentSessionMetadataForOwner(
		input.userId,
		input.parentSessionId,
	);
	if (!parent || parent.projectId !== input.projectId)
		throw new Error("The parent agent is not available.");
	if (!input.prompt.trim()) throw new Error("A brief is required.");
	if (
		input.placement === "shared" &&
		input.access !== "read_only" &&
		!input.sharedWriter
	)
		throw new Error("A subagent on its parent's VM must be read-only.");
	const { session } = await resolveAgentSessionRecord({
		userId: input.userId,
		projectId: input.projectId,
		harness: input.harness,
		parentSessionId: input.parentSessionId,
		title: input.title,
		listedModelId: input.modelId,
		createNew: true,
		task: {
			prompt: input.prompt,
			placement: input.placement,
			access: input.access,
		},
	});
	return session;
}

/** Atomically moves an opened subagent row to working before its first send. */
export async function prepareAgentTaskStart(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly taskSessionId: string;
}) {
	const task = await agentSessionMetadataForOwner(
		input.userId,
		input.taskSessionId,
	);
	if (
		!task ||
		task.projectId !== input.projectId ||
		!task.parentSessionId ||
		!task.taskState
	)
		throw new Error("The subagent is not available.");
	if (task.taskState !== "draft" && task.taskState !== "idle")
		throw new Error("Only a new or idle subagent can be started.");
	await reserveAgentTaskStart(input.userId, input.projectId, task.id);
	const started = await agentSessionMetadataForOwner(input.userId, task.id);
	if (!started) throw new Error("The subagent could not be started.");
	return { task: started };
}

export async function bindAgentSessionMachine(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly harness: AgentProviderId;
		readonly sessionId?: string;
		readonly createNew?: boolean;
		readonly parentSessionId?: string;
		readonly title?: string;
		readonly sourceSnapshotId?: string;
	},
) {
	// The project's network policy is read beside the machine's binding.
	const policy = machines.applyNetworkPolicy
		? projectNetworkPolicy(input.userId, input.projectId)
		: undefined;
	policy?.catch(() => {});
	const { session, workspace } = await turnSpan("bind:session", () =>
		resolveAgentSessionRecord(input),
	);
	// A fork's VM is still being copied: a VM made here would take its slug.
	if (!session.providerRef && (await conversationForkPending(session.id)))
		throw new Error("This chat's workspace is still being prepared.");
	const selectedSession =
		session.harness === input.harness
			? session
			: await selectAgentSessionHarness(
					input.userId,
					input.projectId,
					session.id,
					input.harness,
				);
	if (selectedSession.providerRef && machines.restoreRetainedSession) {
		const providerRef = selectedSession.providerRef;
		const recovered = await turnSpan("bind:retained", async () =>
			machines.restoreRetainedSession?.(input.userId, session.id, providerRef),
		);
		if (recovered) {
			await machines.ensureRunning(WorkspaceId(recovered));
			await applyProjectNetworkPolicy(machines, policy, recovered);
			return {
				session: { ...selectedSession, providerRef: recovered },
				providerRef: recovered,
				replaced: false,
				replacedProviderRef: null,
			};
		}
	}
	const templateSnapshotId =
		input.sourceSnapshotId ?? workspace.templateSnapshotId;
	const plan: Parameters<typeof executeSessionMachinePlan>[0] = {
		machines,
		sessionId: session.id,
		sessionProviderRef: session.providerRef,
		restoreMissingWorkspace: checkpointStorageConfigured()
			? async (newId) => {
					const checkpoint = await checkpointForSession(
						input.userId,
						session.id,
					);
					if (!checkpoint || checkpoint.executor_id !== session.providerRef)
						throw new Error(
							"No checkpoint exists for the lost workspace; recovery stopped without discarding edits.",
						);
					await restoreSessionWorkspace(
						machines,
						input.userId,
						session.id,
						newId,
					);
				}
			: undefined,
		// A root chat whose machine is gone (and has no checkpoint) gets a fresh
		// copy; its committed turns are on its GitHub branch. Codex subscription
		// and API chats both run through api-turn with their transcript in the
		// database, so the harness keeps nothing on the VM worth refusing over.
		replaceMissingReadOnly: !selectedSession.parentSessionId,
		replaceUnstartable: async (vmId, cause) => {
			// Only a failed start of the VM itself counts, never capacity,
			// allowance or auth; and only after it has failed for the whole
			// window, read from the durable record (turns resume on other
			// objects). A failed read never replaces.
			// A spent runtime budget is certain: no wait, replace at once.
			if (machineBudgetSpent(cause)) return true;
			if (!machineStartUnstartable(cause)) return false;
			const streak = await readWakeFailureStreak(vmId);
			return machineStartAbandoned({
				firstFailureAt: streak?.firstAt ?? null,
				failures: streak?.failures,
				now: new Date(),
			});
		},
		workspaceId: workspace.id,
		templateSnapshotId,
		machineSize: selectedSession.providerRef
			? undefined
			: await projectMachineSize(input.userId, input.projectId),
		templateProviderRef: input.sourceSnapshotId ? null : workspace.providerRef,
		saveTemplateSnapshot: (snapshotId) =>
			saveTemplateSnapshot(workspace.id, snapshotId).then(() => undefined),
		saveSessionProviderRef: (providerRef) =>
			saveAgentSessionProviderRef(session.id, providerRef).then(
				() => undefined,
			),
		freshBoot: {
			snapshotId: workspaceBootSnapshotId,
			record: () => markFreshChatMachine(session.id),
		},
	};
	const executed = await turnSpan("bind:machine", () =>
		executeSessionMachinePlan(plan),
	);
	await turnSpan("bind:networkPolicy", () =>
		applyProjectNetworkPolicy(machines, policy, executed.providerRef),
	);
	// A fresh copy of the template has none of the project's saved services
	// running: they start in the background, and how each went is added to
	// the environment report the agent reads.
	// Not awaited, so it runs on plain machine calls: a Stop or a failure of
	// the turn that made the copy never leaves the services unstarted.
	// A fresh boot has no saved services yet (fresh-machine-setup.ts).
	if (executed.planKind !== "resume" && executed.planKind !== "boot-fresh")
		void detachedFromTurn(() =>
			startEnvironmentServices(machines, WorkspaceId(executed.providerRef)),
		).catch(() =>
			console.warn("The project's saved services could not be started."),
		);
	return {
		session: { ...selectedSession, providerRef: executed.providerRef },
		providerRef: executed.providerRef,
		/** True when the chat's VM could not start for too long and a new one replaced it. */
		replaced: executed.planKind === "replace-unstartable",
		/** The VM that was replaced (left running or paused, never destroyed), else null. */
		replacedProviderRef: executed.replacedProviderRef ?? null,
	};
}

/**
 * Every chat machine (writer forks included) gets the project's internet
 * access before its turn runs, so a settings change lands at the next turn.
 */
async function applyProjectNetworkPolicy(
	machines: WorkspaceMachines,
	policy: ReturnType<typeof projectNetworkPolicy> | undefined,
	providerRef: string,
) {
	if (!machines.applyNetworkPolicy || !policy) return;
	await machines.applyNetworkPolicy(WorkspaceId(providerRef), await policy);
}

/**
 * A reader subagent shares its parent's VM; a writer runs on the fork that
 * subagent-tools saved as its provider ref.
 */
export async function bindPreparedAgentTaskMachine(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly task: AgentSessionRecord;
	},
) {
	if (sharesParentMachine(input.task)) {
		if (!input.task.parentSessionId) {
			throw new Error("The reader subagent has no parent machine.");
		}
		const parent = await agentSessionMetadataForOwner(
			input.userId,
			input.task.parentSessionId,
		);
		if (!parent?.providerRef) {
			throw new Error("Start the parent workspace before sharing its state.");
		}
		const recovered = await machines.restoreRetainedSession?.(
			input.userId,
			parent.id,
			parent.providerRef,
		);
		const parentProviderRef = recovered ?? parent.providerRef;
		await machines.ensureRunning(WorkspaceId(parentProviderRef));
		const session = await saveAgentSessionProviderRef(
			input.task.id,
			parentProviderRef,
		);
		return { session, providerRef: parentProviderRef };
	}
	if (input.task.agentRole === "writer")
		await reforkReleasedWriter(machines, input);
	return bindAgentSessionMachine(machines, {
		userId: input.userId,
		projectId: input.projectId,
		harness: input.task.harness,
		sessionId: input.task.id,
		createNew: false,
	});
}

/**
 * A writer whose fork the teardown released (teardownSubagentForks) and that
 * is resumed (agent_send, or a message in its chat) gets a fresh fork of its
 * parent's VM, as a new writer would: its earlier work is in the parent's
 * checkout as the patch and git ref of its report. A release still in
 * progress has its VM deleted first, so the fork's slug is not reused.
 */
async function reforkReleasedWriter(
	machines: WorkspaceMachines,
	input: { readonly userId: string; readonly task: AgentSessionRecord },
) {
	const fork = input.task.agentFork;
	if (!fork?.vmId || (!fork.deletedAt && !fork.releasingAt)) return;
	// A row from before releases cleared it may still name the deleted fork.
	if (input.task.providerRef && input.task.providerRef !== fork.vmId) return;
	if (!input.task.parentSessionId)
		throw new Error("The writer subagent has no parent machine.");
	const parent = await agentSessionMetadataForOwner(
		input.userId,
		input.task.parentSessionId,
	);
	if (!parent?.providerRef)
		throw new Error("Start the parent workspace before resuming its writer.");
	if (!fork.deletedAt) await machines.destroy(WorkspaceId(fork.vmId));
	const parentVm =
		(await machines.restoreRetainedSession?.(
			input.userId,
			parent.id,
			parent.providerRef,
		)) ?? parent.providerRef;
	await machines.ensureRunning(WorkspaceId(parentVm));
	const forked = await forkWriterWorkspace({
		machines,
		parentVm: WorkspaceId(parentVm),
		slug: agentSessionMachineSlug(input.task.id),
	});
	await replaceHelperFork(input.task.id, {
		vmId: forked.vm,
		sourceVmId: parentVm,
		forkMs: forked.forkMs,
		bootedAt: new Date().toISOString(),
		base: forked.base,
		parentHead: forked.parentHead,
	});
}

export async function peekAgentSessionMachine(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId?: string;
}): Promise<{
	session: Omit<AgentSessionRecord, "items"> | null;
	providerRef: string | null;
}> {
	// A named chat is read by id, else the project's latest; never its
	// history, which can run to megabytes and is not needed here.
	const session = input.sessionId
		? await agentSessionMetadataForOwner(input.userId, input.sessionId)
		: await latestAgentSessionMetadata(input.userId, input.projectId);
	return { session, providerRef: session?.providerRef ?? null };
}

/**
 * Deletes this agent session and its child copies. The project snapshot and
 * template VM stay. A session that was attached to the template before
 * snapshots existed only drops the row.
 */
/**
 * Deletes a chat and its subagent chats: their stored checkpoints, context
 * archives and attachments, their own VMs, then their rows, then the
 * retained-recovery VMs and snapshots only they referenced.
 *
 * Storage and VM failures before the rows go stop the deletion so a retry
 * finds everything again. Retained resources go only once the rows are gone;
 * a failure there is logged and left to provider expiry.
 */
export async function deleteAgentSessionMachine(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly sessionId: string;
	},
) {
	const session = await agentSessionMetadataForOwner(
		input.userId,
		input.sessionId,
	);
	if (!session || session.projectId !== input.projectId) {
		throw new Error("Agent session is not available.");
	}
	const workspace = await workspaceForProject(input.userId, input.projectId);
	// Ids, machines and roles only: no transcript is read to delete one.
	const children = await descendantAgentSessionMetadata(
		input.userId,
		session.id,
	);
	const removed = [session, ...children];
	// Their running turns stop before their state goes (cancel, then purge).
	for (const chat of removed)
		await cancelServerTurn(input.userId, chat.id, "chat-delete");
	if (checkpointStorageConfigured())
		for (const chat of removed) await removeChatObjects(input.userId, chat.id);
	for (const chat of removed)
		await purgeConversationState(input.userId, chat.id);
	const retained = await chatCleanupTargets(
		input.userId,
		removed.map((chat) => chat.id),
	);
	// Readers run on their parent's VM: never destroy it with them. A VM a
	// session outside this deletion still holds (the parent of a deleted
	// reader, or a legacy shared child's parent) is never destroyed either.
	const held = await providerRefsHeldOutside(
		input.userId,
		removed.map((chat) => chat.id),
	);
	const refs = sessionMachineRefsToDestroy({
		sessionProviderRef: sharesParentMachine(session)
			? null
			: session.providerRef,
		childProviderRefs: children
			.filter((child) => !sharesParentMachine(child))
			.map((child) => child.providerRef),
		templateProviderRef: workspace?.providerRef ?? null,
	}).filter((ref) => !held.has(ref));
	// A machine copied ahead that the chat never adopted (machine-prewarm.ts).
	const prewarmed = session.providerRef
		? null
		: await prewarmedMachine(input.userId, session.id);
	if (prewarmed && !held.has(prewarmed) && !refs.includes(prewarmed))
		refs.push(prewarmed);
	for (const ref of refs) {
		await machines.destroy(WorkspaceId(ref));
	}
	await deleteAgentSessionForOwner(input.userId, session.id);
	const sharedToolsSnapshot = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
	const leftovers: string[] = [];
	for (const vmId of retained.vmIds.filter((id) => !refs.includes(id)))
		await machines.destroy(WorkspaceId(vmId)).catch(() => {
			leftovers.push(`vm:${vmId}`);
		});
	for (const snapshotId of retained.snapshotIds.filter(
		(id) => id !== sharedToolsSnapshot,
	))
		await machines.destroySnapshot(AuthSnapshotId(snapshotId)).catch(() => {
			leftovers.push(`snapshot:${snapshotId}`);
		});
	if (leftovers.length)
		console.warn("Chat deletion left provider resources to expire.", {
			sessionId: session.id,
			leftovers,
		});
}

export async function executeSessionMachinePlan(input: {
	readonly machines: Pick<
		WorkspaceMachines,
		| "snapshotEnvironment"
		| "provisionSession"
		| "ensureRunning"
		| "exec"
		| "writeTextFile"
		| "rebindRetainedSession"
		| "replacementSessionSlug"
	>;
	readonly sessionId: string;
	readonly sessionProviderRef: string | null;
	readonly replaceMissingReadOnly?: boolean;
	/**
	 * Whether a VM that failed to start (with `cause`) has refused for long
	 * enough that the chat should get a new one. Only asked for a root chat
	 * (replaceMissingReadOnly) resuming its VM. Left out, never replaced.
	 */
	readonly replaceUnstartable?: (
		vmId: string,
		cause: unknown,
	) => Promise<boolean>;
	readonly restoreMissingWorkspace?: (newId: string) => Promise<void>;
	readonly workspaceId: string;
	readonly templateSnapshotId: string | null;
	readonly machineSize?: MachineSizeId;
	readonly templateProviderRef: string | null;
	readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
	readonly saveSessionProviderRef: (providerRef: string) => Promise<void>;
	readonly wait?: (ms: number) => Promise<void>;
	/**
	 * A chat whose project has no template yet: the image it boots from, and
	 * the record that it did (made before the machine is named on the chat,
	 * so a retry finds it). Left out, such a chat is refused as before.
	 */
	readonly freshBoot?: {
		readonly snapshotId: () => Promise<string>;
		readonly record: () => Promise<void>;
	};
}): Promise<{
	providerRef: string;
	planKind:
		| SessionMachinePlan["kind"]
		| "recover-read-only"
		| "recover-checkpoint"
		| "replace-unstartable";
	/** The VM a replace-unstartable copy replaced; never destroyed (it may hold unpushed work). */
	replacedProviderRef?: string;
}> {
	let snapshotId = input.templateSnapshotId;
	let plan = sessionMachinePlan({
		sessionProviderRef: input.sessionProviderRef,
		templateSnapshotId: snapshotId,
		templateProviderRef: input.templateProviderRef,
	});
	if (plan.kind === "needs-snapshot") {
		await input.machines.ensureRunning(WorkspaceId(plan.providerRef));
		snapshotId = await input.machines.snapshotEnvironment(
			WorkspaceId(plan.providerRef),
			projectEnvironmentSnapshotSlug(input.workspaceId),
			input.machineSize,
		);
		await input.saveTemplateSnapshot(snapshotId);
		plan = sessionMachinePlan({
			sessionProviderRef: input.sessionProviderRef,
			templateSnapshotId: snapshotId,
			templateProviderRef: input.templateProviderRef,
		});
	}
	if (plan.kind === "resume") {
		try {
			await input.machines.ensureRunning(WorkspaceId(plan.providerRef));
		} catch (cause) {
			if (
				input.restoreMissingWorkspace &&
				workspaceLooksGone(failureMessage(cause)) &&
				snapshotId
			) {
				const replacement = await copyAgentSessionFromTemplate(
					input,
					snapshotId,
				);
				// Before the copy's first admitted use: retention still names the lost VM.
				await input.machines.rebindRetainedSession?.(
					input.sessionId,
					plan.providerRef,
					replacement,
				);
				await resetCopiedSessionScratch(input.machines, replacement);
				await input.restoreMissingWorkspace(replacement);
				await input.saveSessionProviderRef(replacement);
				return { providerRef: replacement, planKind: "recover-checkpoint" };
			}
			const gone = workspaceLooksGone(failureMessage(cause));
			if (
				input.replaceMissingReadOnly &&
				snapshotId &&
				!gone &&
				input.replaceUnstartable &&
				(await input.replaceUnstartable(plan.providerRef, cause))
			) {
				// The old VM stays (it may hold unpushed work and expires on its
				// own); the copy gets the next generation's slug so it cannot
				// adopt it. A retry after a crash finds this copy by that slug.
				const slug = input.machines.replacementSessionSlug
					? await input.machines.replacementSessionSlug(
							input.sessionId,
							plan.providerRef,
						)
					: nextAgentSessionMachineSlug(input.sessionId, null);
				const replacement = await copyAgentSessionFromTemplate(
					input,
					snapshotId,
					slug,
				);
				await input.machines.rebindRetainedSession?.(
					input.sessionId,
					plan.providerRef,
					replacement,
				);
				await input.saveSessionProviderRef(replacement);
				await resetCopiedSessionScratch(input.machines, replacement);
				return {
					providerRef: replacement,
					planKind: "replace-unstartable",
					replacedProviderRef: plan.providerRef,
				};
			}
			if (!input.replaceMissingReadOnly || !gone || !snapshotId) {
				throw cause;
			}
			const replacement = await copyAgentSessionFromTemplate(input, snapshotId);
			await input.machines.rebindRetainedSession?.(
				input.sessionId,
				plan.providerRef,
				replacement,
			);
			await input.saveSessionProviderRef(replacement);
			await resetCopiedSessionScratch(input.machines, replacement);
			return { providerRef: replacement, planKind: "recover-read-only" };
		}
		if (!input.sessionProviderRef)
			await input.saveSessionProviderRef(plan.providerRef);
		return { providerRef: plan.providerRef, planKind: plan.kind };
	}
	if (plan.kind === "boot-fresh") {
		if (!input.freshBoot)
			throw new Error(
				"Prepare a project environment before starting an agent.",
			);
		// Nothing to reseal (there is no template): only capacity lag is retried.
		const booted = await copyAgentSessionFromTemplate(
			input,
			await input.freshBoot.snapshotId(),
		);
		await input.freshBoot.record();
		await input.saveSessionProviderRef(booted);
		return { providerRef: booted, planKind: plan.kind };
	}
	if (plan.kind !== "copy-snapshot") {
		throw new Error("Could not copy the project snapshot.");
	}
	const copied = await copyAgentSessionFromTemplate(input, plan.snapshotId);
	// Independent: the chat's row names its copy while the copy's scratch
	// files are cleared (the copy is slug-keyed, so a retry finds it either way).
	await Promise.all([
		input.saveSessionProviderRef(copied),
		resetCopiedSessionScratch(input.machines, copied),
	]);
	return { providerRef: copied, planKind: plan.kind };
}

async function copyAgentSessionFromTemplate(
	input: {
		readonly machines: Pick<
			WorkspaceMachines,
			"snapshotEnvironment" | "provisionSession" | "ensureRunning"
		>;
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly templateProviderRef: string | null;
		readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
		readonly wait?: (ms: number) => Promise<void>;
		readonly machineSize?: MachineSizeId;
	},
	snapshotId: string,
	machineSlug?: string,
) {
	const slug = machineSlug ?? agentSessionMachineSlug(input.sessionId);
	try {
		return await input.machines.provisionSession(
			slug,
			snapshotId,
			input.machineSize,
		);
	} catch (cause) {
		const message = failureMessage(cause);
		if (
			shouldResealProjectSnapshotAfterCopyFailure(message) &&
			input.templateProviderRef
		) {
			await input.machines.ensureRunning(
				WorkspaceId(input.templateProviderRef),
			);
			const nextSnapshotId = await input.machines.snapshotEnvironment(
				WorkspaceId(input.templateProviderRef),
				projectEnvironmentSnapshotSlug(input.workspaceId),
				input.machineSize,
			);
			await input.saveTemplateSnapshot(nextSnapshotId);
			return await input.machines.provisionSession(
				slug,
				nextSnapshotId,
				input.machineSize,
			);
		}
		return await retryCopyAfterCapacityLag(input.machines, slug, snapshotId, {
			cause,
			wait: input.wait,
			machineSize: input.machineSize,
		});
	}
}

async function retryCopyAfterCapacityLag(
	machines: Pick<WorkspaceMachines, "provisionSession">,
	slug: string,
	snapshotId: string,
	input: {
		readonly cause: unknown;
		readonly wait?: (ms: number) => Promise<void>;
		readonly machineSize?: MachineSizeId;
	},
) {
	const wait =
		input.wait ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}));
	let cause = input.cause;
	for (const delay of workspaceCopyCapacityRetryDelaysMs(
		failureMessage(cause),
	)) {
		await wait(delay);
		try {
			return await machines.provisionSession(
				slug,
				snapshotId,
				input.machineSize,
			);
		} catch (retryCause) {
			cause = retryCause;
			if (
				workspaceCopyCapacityRetryDelaysMs(failureMessage(retryCause))
					.length === 0
			) {
				throw retryCause;
			}
		}
	}
	throw cause;
}

/**
 * Guest `rm` of `/tmp` can fail when the snapshot files are root-owned
 * (sticky bit). Freestyle `exec` is not a shell, so reset uses one direct
 * `rm -rf` argv instead of `bash -lc`.
 */
async function resetCopiedSessionScratch(
	machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
	copied: WorkspaceId,
) {
	await Promise.all(
		copiedSessionScratchResetCommands().map((command) =>
			machines.exec(copied, command, 15_000),
		),
	);
}
