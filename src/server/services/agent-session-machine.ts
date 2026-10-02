import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	COPIED_SESSION_STATUS_RESETS,
	copiedSessionScratchResetCommands,
	projectEnvironmentSnapshotSlug,
	type SessionMachinePlan,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
	shouldResealProjectSnapshotAfterCopyFailure,
	workspaceCopyCapacityRetryDelaysMs,
} from "#/domain/agent-session";
import {
	type AgentTaskAccess,
	type AgentTaskExecution,
	type AgentTaskPlacement,
	agentTaskStartBlockedByDependency,
	canSpawnAgentTask,
	validateAgentTaskPlan,
} from "#/domain/agent-task";
import { failureMessage, workspaceLooksGone } from "#/domain/failure-message";
import { WorkspaceId } from "#/domain/ids";
import { listedModelPreferenceFromSessions } from "#/domain/listed-model";
import { projectCheckoutFromFullName } from "#/domain/project-checkout";
import {
	PROJECT_CONTEXT_PATH,
	projectContextDocument,
	promptTextWithProjectContext,
	relatedTracesForTask,
} from "#/domain/project-context";
import { workspaceEnvironmentIsReady } from "#/domain/project-workspace";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	childAgentSession,
	deleteAgentSessionForOwner,
	descendantAgentSessions,
	insertAgentSession,
	listAgentSessions,
	saveAgentSessionProviderRef,
	saveAgentTaskDraft,
	saveAgentTaskState,
	selectAgentSessionHarness,
} from "#/server/adapters/agent-sessions";
import { receiveBrokeredRepository } from "#/server/adapters/github/git-broker";
import {
	listProjectTraces,
	loadProjectBriefing,
} from "#/server/adapters/project-context";
import { projectForOwner } from "#/server/adapters/projects";
import { repositoryDirectory } from "#/server/adapters/repository-setup";
import {
	saveTemplateSnapshot,
	workspaceForProject,
} from "#/server/adapters/workspaces";
import { checkpointForSession } from "../adapters/checkpoints/records";
import { removeCheckpoint } from "../adapters/checkpoints/storage";
import { providerProjectTemplateSnapshot } from "./provider-project-template";
import { restoreSessionWorkspace } from "./session-checkpoint";
import type { WorkspaceMachines } from "./workspace-machines";

async function resolveAgentSessionRecord(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly harness: AgentProviderId;
	readonly sessionId?: string;
	readonly createNew?: boolean;
	readonly parentSessionId?: string;
	readonly candidateIndex?: number;
	readonly competitionId?: string;
	readonly title?: string;
	readonly listedModelId?: string;
	readonly task?: {
		readonly prompt: string;
		readonly placement: AgentTaskPlacement;
		readonly access: AgentTaskAccess;
		readonly execution: AgentTaskExecution;
		readonly dependsOnSessionId: string | null;
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
			candidateIndex: input.candidateIndex,
			competitionId: input.competitionId,
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
}) {
	const { session } = await resolveAgentSessionRecord({
		...input,
		createNew: true,
	});
	return session;
}

/**
 * Creates a child task under any session. The parent chain is deliberately
 * bounded so recursive delegation cannot grow without limit.
 */
export async function openAgentTask(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly parentSessionId: string;
	readonly candidateIndex?: number;
	readonly competitionId?: string;
	readonly title: string;
	readonly harness: AgentProviderId;
	readonly modelId: string;
	readonly prompt: string;
	readonly placement: AgentTaskPlacement;
	readonly access: AgentTaskAccess;
	readonly execution: AgentTaskExecution;
	readonly dependsOnSessionId: string | null;
}) {
	let parent = await agentSessionForOwner(input.userId, input.parentSessionId);
	if (!parent || parent.projectId !== input.projectId) {
		throw new Error("The parent task is not available.");
	}
	let parentDepth = 0;
	while (parent.parentSessionId) {
		parentDepth += 1;
		const next = await agentSessionForOwner(
			input.userId,
			parent.parentSessionId,
		);
		if (!next || next.projectId !== input.projectId) {
			throw new Error("The task hierarchy is invalid.");
		}
		parent = next;
	}
	if (!canSpawnAgentTask(parentDepth)) {
		throw new Error("Tasks can delegate at most three levels deep.");
	}
	const invalidPlan = validateAgentTaskPlan({
		prompt: input.prompt,
		placement: input.placement,
		access: input.access,
		execution: input.execution,
		dependsOnSessionId: input.dependsOnSessionId,
	});
	if (invalidPlan) throw new Error(invalidPlan);
	if (input.dependsOnSessionId) {
		const predecessor = await agentSessionForOwner(
			input.userId,
			input.dependsOnSessionId,
		);
		if (
			!predecessor ||
			predecessor.projectId !== input.projectId ||
			predecessor.parentSessionId !== input.parentSessionId
		) {
			throw new Error("A stacked predecessor must be a sibling task.");
		}
	}
	const { session } = await resolveAgentSessionRecord({
		userId: input.userId,
		projectId: input.projectId,
		harness: input.harness,
		parentSessionId: input.parentSessionId,
		candidateIndex: input.candidateIndex,
		competitionId: input.competitionId,
		title: input.title,
		listedModelId: input.modelId,
		createNew: true,
		task: {
			prompt: input.prompt,
			placement: input.placement,
			access: input.access,
			execution: input.execution,
			dependsOnSessionId: input.dependsOnSessionId,
		},
	});
	return session;
}

export async function editAgentTaskDraft(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly taskSessionId: string;
	readonly title: string;
	readonly harness: AgentProviderId;
	readonly modelId: string;
	readonly prompt: string;
	readonly placement: AgentTaskPlacement;
	readonly access: AgentTaskAccess;
	readonly execution: AgentTaskExecution;
	readonly dependsOnSessionId: string | null;
}) {
	const draft = await agentSessionForOwner(input.userId, input.taskSessionId);
	if (
		!draft ||
		draft.projectId !== input.projectId ||
		!draft.parentSessionId ||
		draft.taskState !== "draft" ||
		draft.providerRef
	) {
		throw new Error("Only an unstarted task draft can be edited.");
	}
	const invalidPlan = validateAgentTaskPlan({
		prompt: input.prompt,
		placement: input.placement,
		access: input.access,
		execution: input.execution,
		dependsOnSessionId: input.dependsOnSessionId,
	});
	if (invalidPlan) throw new Error(invalidPlan);
	if (input.harness === "opencode") {
		throw new Error("This runtime is no longer offered for new tasks.");
	}
	if (!input.title.trim() || !input.modelId.trim()) {
		throw new Error("A task title and model are required.");
	}
	if (input.dependsOnSessionId) {
		const predecessor = await agentSessionForOwner(
			input.userId,
			input.dependsOnSessionId,
		);
		if (
			!predecessor ||
			predecessor.projectId !== input.projectId ||
			predecessor.parentSessionId !== draft.parentSessionId ||
			predecessor.id === draft.id
		) {
			throw new Error("A stacked predecessor must be another sibling task.");
		}
	}
	const saved = await saveAgentTaskDraft({
		userId: input.userId,
		sessionId: draft.id,
		title: input.title.trim().slice(0, 120),
		prompt: input.prompt.trim(),
		harness: input.harness,
		modelId: input.modelId.trim(),
		placement: input.placement,
		access: input.access,
		execution: input.execution,
		dependsOnSessionId: input.dependsOnSessionId,
	});
	if (!saved) throw new Error("The task draft changed before it was saved.");
	return saved;
}

/**
 * Validates a stored draft immediately before execution. Capacity is checked
 * here because drafts consume neither a runtime slot nor model tokens.
 */
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
		!task.taskState ||
		!task.taskPlacement ||
		!task.taskAccess ||
		!task.taskExecution
	) {
		throw new Error("The task draft is not available.");
	}
	if (task.taskState !== "draft" && task.taskState !== "idle") {
		throw new Error("Only a draft or idle task can be started.");
	}
	await rootAgentSession(input.userId, input.projectId, task);
	const predecessor = task.dependsOnSessionId
		? await agentSessionForOwner(input.userId, task.dependsOnSessionId)
		: null;
	const dependencyBlock = agentTaskStartBlockedByDependency(
		{
			execution: task.taskExecution,
			dependsOnSessionId: task.dependsOnSessionId,
		},
		predecessor
			? {
					status: predecessor.taskState ?? "idle",
					reviewState: predecessor.taskReviewState ?? "pending",
					branch: predecessor.taskBranch,
				}
			: null,
	);
	if (dependencyBlock) throw new Error(dependencyBlock);
	const started = await saveAgentTaskState(task.id, "working");
	if (!started) throw new Error("The task draft could not be started.");
	return { task: started, predecessor };
}

async function rootAgentSession(
	userId: string,
	projectId: string,
	start: AgentSessionRecord,
) {
	let current = start;
	while (current.parentSessionId) {
		const parent = await agentSessionForOwner(userId, current.parentSessionId);
		if (!parent || parent.projectId !== projectId) {
			throw new Error("The task hierarchy is invalid.");
		}
		current = parent;
	}
	return current;
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
	const templateSnapshotId =
		input.sourceSnapshotId ??
		(session.providerRef
			? workspace.templateSnapshotId
			: await providerProjectTemplateSnapshot({
					machines,
					userId: input.userId,
					projectId: input.projectId,
					workspaceId: workspace.id,
					projectSnapshotId: workspace.templateSnapshotId,
					harness: input.harness,
				}));
	const executed = await executeSessionMachinePlan({
		machines,
		sessionId: session.id,
		sessionProviderRef: session.providerRef,
		restoreMissingWorkspace: process.env.SUPABASE_STORAGE_SERVICE_KEY
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
		replaceMissingReadOnly:
			input.harness === "api" &&
			!selectedSession.parentSessionId &&
			selectedSession.taskAccess === "read_only",
		workspaceId: workspace.id,
		templateSnapshotId,
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
 * Assigns the execution machine selected by a validated task plan. Stacked
 * work copies the reviewed predecessor state rather than the clean template.
 */
export async function bindPreparedAgentTaskMachine(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly task: AgentSessionRecord;
		readonly predecessor: AgentSessionRecord | null;
	},
) {
	let sourceSnapshotId: string | undefined;
	if (input.task.taskPlacement === "shared") {
		if (!input.task.parentSessionId) {
			throw new Error("The read-only task has no parent machine.");
		}
		const parent = await agentSessionForOwner(
			input.userId,
			input.task.parentSessionId,
		);
		if (!parent?.providerRef) {
			throw new Error("Start the parent workspace before sharing its state.");
		}
		await machines.ensureRunning(WorkspaceId(parent.providerRef));
		const session = await saveAgentSessionProviderRef(
			input.task.id,
			parent.providerRef,
		);
		return { session, providerRef: parent.providerRef };
	} else if (
		input.task.taskExecution === "stacked" &&
		!input.predecessor?.taskBranch
	) {
		throw new Error(
			"Publish the reviewed predecessor before starting stacked work.",
		);
	}
	const bound = await bindAgentSessionMachine(machines, {
		userId: input.userId,
		projectId: input.projectId,
		harness: input.task.harness,
		sessionId: input.task.id,
		createNew: false,
		sourceSnapshotId,
	});
	if (input.task.taskExecution === "stacked" && input.predecessor?.taskBranch) {
		await checkoutStackedTaskBase(machines, bound.providerRef, {
			userId: input.userId,
			projectId: input.projectId,
			branch: input.predecessor.taskBranch,
		});
	}
	return bound;
}

async function checkoutStackedTaskBase(
	machines: WorkspaceMachines,
	providerRef: string,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly branch: string;
	},
) {
	const project = await projectForOwner(input.userId, input.projectId);
	const checkout = project
		? projectCheckoutFromFullName({
				fullName: project.fullName,
				branch: project.branch,
				installationId: project.installationId,
			})
		: null;
	if (!project || !checkout)
		throw new Error("The stacked project is unavailable.");
	const workspaceId = WorkspaceId(providerRef);
	const result = await receiveBrokeredRepository(
		{
			exec: (command, timeout) => machines.exec(workspaceId, command, timeout),
			writeTextFile: (path, text) =>
				machines.writeTextFile(workspaceId, path, text),
		},
		{
			...checkout,
			branch: input.branch,
			workingBranch: input.branch,
			destination: repositoryDirectory(project.fullName),
			mode: "update",
		},
	);
	if (result !== "updated")
		throw new Error("The stacked predecessor branch could not be checked out.");
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
 * Deletes this agent session and its side-chat copy. The project snapshot and
 * template VM stay. A session that was attached to the template before
 * snapshots existed only drops the row.
 */
export async function deleteAgentSessionMachine(
	machines: Pick<WorkspaceMachines, "destroy" | "destroyCodexSession">,
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
	for (const removed of [session, ...children]) {
		if (process.env.SUPABASE_STORAGE_SERVICE_KEY) {
			const checkpoint = await checkpointForSession(input.userId, removed.id);
			if (checkpoint) await removeCheckpoint(checkpoint.object_path);
		}
	}
	const refs = sessionMachineRefsToDestroy({
		sessionProviderRef:
			session.taskPlacement === "shared" ? null : session.providerRef,
		childProviderRefs: children
			.filter((child) => child.taskPlacement !== "shared")
			.map((child) => child.providerRef),
		templateProviderRef: workspace?.providerRef ?? null,
	});
	for (const ref of refs) {
		await machines.destroy(WorkspaceId(ref));
	}
	await deleteAgentSessionForOwner(input.userId, session.id);
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
	readonly templateProviderRef: string | null;
	readonly authSnapshotId?: string | null;
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
		authSnapshotId: input.authSnapshotId,
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
			authSnapshotId: input.authSnapshotId,
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
	},
	snapshotId: string,
) {
	const slug = agentSessionMachineSlug(input.sessionId);
	try {
		return await input.machines.provisionSession(slug, snapshotId);
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
			return await input.machines.provisionSession(slug, nextSnapshotId);
		}
		return await retryCopyAfterCapacityLag(input.machines, slug, snapshotId, {
			cause,
			wait: input.wait,
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
			return await machines.provisionSession(slug, snapshotId);
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
 * `rm -rf` argv instead of `bash -lc`. Status files are overwritten through
 * the FS API so Connect cannot reload the template chat.
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
	await Promise.all(
		COPIED_SESSION_STATUS_RESETS.map((file) =>
			machines.writeTextFile(copied, file.path, file.contents),
		),
	);
}

export async function syncProjectContextForTask(
	machines: Pick<WorkspaceMachines, "writeTextFile">,
	providerRef: string,
	input: { readonly projectId: string; readonly task: string },
): Promise<string> {
	const briefing = await loadProjectBriefing(input.projectId);
	const traces = relatedTracesForTask(
		await listProjectTraces(input.projectId),
		input.task,
	);
	const document = projectContextDocument({ briefing, traces });
	if (document) {
		await machines.writeTextFile(
			WorkspaceId(providerRef),
			PROJECT_CONTEXT_PATH,
			`${document}\n`,
		);
	}
	return promptTextWithProjectContext({
		task: input.task,
		document,
	});
}
