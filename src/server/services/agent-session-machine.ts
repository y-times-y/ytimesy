import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	copiedSessionScratchResetCommands,
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
import type { MachineSizeId } from "#/domain/machine-size";
import { workspaceEnvironmentIsReady } from "#/domain/project-workspace";
import { sessionTitleFromText } from "#/domain/session-item";
import { sharesParentMachine } from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	childAgentSession,
	deleteAgentSessionForOwner,
	descendantAgentSessions,
	insertAgentSession,
	listAgentSessions,
	providerRefsHeldOutside,
	reusableEmptyChat,
	saveAgentSessionProviderRef,
	selectAgentSessionHarness,
} from "#/server/adapters/agent-sessions";
import { projectMachineSize } from "#/server/adapters/project-machine-size";
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
import { restoreSessionWorkspace } from "./session-checkpoint";
import type { WorkspaceMachines } from "./workspace-machines";

async function resolveAgentSessionRecord(input: {
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
}) {
	const workspace = await workspaceForProject(input.userId, input.projectId);
	if (!workspace || !workspaceEnvironmentIsReady(workspace)) {
		throw new Error("Prepare a project environment before starting an agent.");
	}
	const sessions = await listAgentSessions(input.userId, input.projectId);
	const selected = input.createNew
		? null
		: input.sessionId
			? ((await agentSessionForOwner(input.userId, input.sessionId)) ??
				sessions.find((session) => session.id === input.sessionId) ??
				null)
			: input.parentSessionId
				? await childAgentSession(input.userId, input.parentSessionId)
				: (sessions[0] ?? null);
	if (input.sessionId && !input.createNew && !selected) {
		throw new Error("Agent session is not available.");
	}
	if (selected && selected.projectId !== input.projectId) {
		throw new Error("Agent session is not in this project.");
	}
	const parent = input.parentSessionId
		? ((await agentSessionForOwner(input.userId, input.parentSessionId)) ??
			null)
		: null;
	if (parent && parent.projectId !== input.projectId) {
		throw new Error("The parent task is not in this project.");
	}
	const inherited = listedModelPreferenceFromSessions({
		harness: input.harness,
		sessions: [
			...(parent
				? [
						{
							harness: parent.harness,
							listedModelId: parent.listedModelId,
							items: parent.items,
						},
					]
				: []),
			...sessions.map((session) => ({
				harness: session.harness,
				listedModelId: session.listedModelId,
				items: session.items,
			})),
		],
	});
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
				input.listedModelId?.trim() || inherited.listedModelId || null,
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
}) {
	const parent = await agentSessionForOwner(
		input.userId,
		input.parentSessionId,
	);
	if (!parent || parent.projectId !== input.projectId)
		throw new Error("The parent agent is not available.");
	if (!input.prompt.trim()) throw new Error("A brief is required.");
	if (input.placement === "shared" && input.access !== "read_only")
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
	const task = await agentSessionForOwner(input.userId, input.taskSessionId);
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
	const started = await agentSessionForOwner(input.userId, task.id);
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
	const { session, workspace } = await resolveAgentSessionRecord(input);
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
		const recovered = await machines.restoreRetainedSession(
			input.userId,
			session.id,
			selectedSession.providerRef,
		);
		if (recovered) {
			await machines.ensureRunning(WorkspaceId(recovered));
			return {
				session: { ...selectedSession, providerRef: recovered },
				providerRef: recovered,
			};
		}
	}
	const templateSnapshotId =
		input.sourceSnapshotId ?? workspace.templateSnapshotId;
	const executed = await executeSessionMachinePlan({
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
	});
	return {
		session: { ...selectedSession, providerRef: executed.providerRef },
		providerRef: executed.providerRef,
	};
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
		const parent = await agentSessionForOwner(
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
	return bindAgentSessionMachine(machines, {
		userId: input.userId,
		projectId: input.projectId,
		harness: input.task.harness,
		sessionId: input.task.id,
		createNew: false,
	});
}

export async function peekAgentSessionMachine(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId?: string;
}): Promise<{
	session: AgentSessionRecord | null;
	providerRef: string | null;
}> {
	const sessions = await listAgentSessions(input.userId, input.projectId);
	const session = input.sessionId
		? ((await agentSessionForOwner(input.userId, input.sessionId)) ??
			sessions.find((row) => row.id === input.sessionId) ??
			null)
		: (sessions[0] ?? null);
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
	const session = await agentSessionForOwner(input.userId, input.sessionId);
	if (!session || session.projectId !== input.projectId) {
		throw new Error("Agent session is not available.");
	}
	const workspace = await workspaceForProject(input.userId, input.projectId);
	const children = await descendantAgentSessions(input.userId, session.id);
	const removed = [session, ...children];
	if (checkpointStorageConfigured())
		for (const chat of removed) await removeChatObjects(input.userId, chat.id);
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
	>;
	readonly sessionId: string;
	readonly sessionProviderRef: string | null;
	readonly replaceMissingReadOnly?: boolean;
	readonly restoreMissingWorkspace?: (newId: string) => Promise<void>;
	readonly workspaceId: string;
	readonly templateSnapshotId: string | null;
	readonly machineSize?: MachineSizeId;
	readonly templateProviderRef: string | null;
	readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
	readonly saveSessionProviderRef: (providerRef: string) => Promise<void>;
	readonly wait?: (ms: number) => Promise<void>;
}): Promise<{
	providerRef: string;
	planKind:
		| SessionMachinePlan["kind"]
		| "recover-read-only"
		| "recover-checkpoint";
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
		);
		await input.saveTemplateSnapshot(snapshotId);
		plan = sessionMachinePlan({
			sessionProviderRef: input.sessionProviderRef,
			templateSnapshotId: snapshotId,
			templateProviderRef: input.templateProviderRef,
		});
	}
	if (plan.kind === "blocked") throw new Error(plan.reason);
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
				await resetCopiedSessionScratch(input.machines, replacement);
				await input.restoreMissingWorkspace(replacement);
				await input.saveSessionProviderRef(replacement);
				return { providerRef: replacement, planKind: "recover-checkpoint" };
			}
			if (
				!input.replaceMissingReadOnly ||
				!workspaceLooksGone(failureMessage(cause)) ||
				!snapshotId
			) {
				throw cause;
			}
			const replacement = await copyAgentSessionFromTemplate(input, snapshotId);
			await input.saveSessionProviderRef(replacement);
			await resetCopiedSessionScratch(input.machines, replacement);
			return { providerRef: replacement, planKind: "recover-read-only" };
		}
		if (!input.sessionProviderRef)
			await input.saveSessionProviderRef(plan.providerRef);
		return { providerRef: plan.providerRef, planKind: plan.kind };
	}
	if (plan.kind !== "copy-snapshot") {
		throw new Error("Could not copy the project snapshot.");
	}
	const copied = await copyAgentSessionFromTemplate(input, plan.snapshotId);
	await input.saveSessionProviderRef(copied);
	await resetCopiedSessionScratch(input.machines, copied);
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
) {
	const slug = agentSessionMachineSlug(input.sessionId);
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
