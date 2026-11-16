import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	agentSessionMachineSlug,
	copiedSessionScratchResetCommands,
} from "#/domain/agent-session";
import {
	CONVERSATION_FORK_UNAVAILABLE,
	type ConversationForkJournal,
	conversationForkEnabled,
	conversationForkStatus,
} from "#/domain/conversation-fork";
import {
	publicRecoveryFailure,
	RecoveryRefused,
} from "#/domain/conversation-recovery-failure";
import { WorkspaceId } from "#/domain/ids";
import { jsonbText } from "#/domain/jsonb";
import { redactSecrets } from "#/domain/redact-secrets";
import { sessionBranchName } from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { type SubagentRole, writesOwnCheckout } from "#/domain/subagent";
import { configuredTurnExecutor } from "#/domain/turn-executor";
import { startAfterResponse } from "../adapters/after-response";
import {
	type AgentSessionRecord,
	agentSessionItemsOfKindsForOwner,
	agentSessionMetadataForOwner,
	projectBranchHeldByOtherSession,
} from "../adapters/agent-sessions";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import {
	bindConversationForkVm,
	conversationForkJournal,
	failConversationFork,
	openConversationForkJournal,
	retryConversationForkJournal,
} from "../adapters/conversation-fork";
import {
	type ConversationPoint,
	conversationPoint,
	conversationPointState,
	laterConversationCode,
	saveRecoveredConversation,
} from "../adapters/conversation-recovery";
import { database } from "../adapters/database";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { projectMachineSize } from "../adapters/project-machine-size";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	assertConversationCodePresent,
	captureConversationCode,
	restoreConversationCode,
	startCheckoutFromConversationCode,
} from "./conversation-code-checkpoint";
import {
	holdSettledConversationTurn,
	type SettledConversationTurnHold,
} from "./conversation-turn-settled";
import { WorkspaceProvisionError } from "./errors";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

export const conversationRecoveryRequest = z.object({
	projectId: z.uuid(),
	sessionId: z.uuid(),
	messageId: z.string().min(1).max(200),
	mode: z.enum(["conversation", "code", "both", "fork"]),
});

export async function ensureConversationCodePoint(
	userId: string,
	sessionId: string,
	messageId: string,
	workspace: AgentToolWorkspace,
) {
	const point = await conversationPointState(userId, sessionId, messageId);
	if (!point.exists || point.hasCode) return;
	const code = await captureConversationCode(workspace);
	await database().query(
		`update agent_task_command_receipt r set response=jsonb_set(response,'{result,code}',$4::jsonb),updated_at=now()
    from agent_session s where s.id=r.parent_session_id and s.user_id=$1 and s.id=$2 and r.request_id=$3 and response->'result'->'code' is null`,
		[
			userId,
			sessionId,
			`conversation-point:${messageId}`,
			JSON.stringify(code),
		],
	);
}

/**
 * Code points exist only where the turn wrote to the session's own checkout: a
 * builder-direct root chat or an isolated writer subagent. Readers run inside
 * their parent's VM, so they never rewind it.
 */
export function ownsWritableCheckout(row: {
	provider_ref?: string | null;
	parent_session_id?: string | null;
	agent_role?: SubagentRole | null;
}) {
	return (
		!!row.provider_ref &&
		writesOwnCheckout({
			parentSessionId: row.parent_session_id ?? null,
			agentRole: row.agent_role,
		})
	);
}

/**
 * Where a fork's code starts: a copy of the source VM at the message's code,
 * or (when the source never had a checkout of its own, so its code never
 * moved) a fresh checkout made at its first turn.
 */
export function forkCodeStart(input: {
	ownsCheckout: boolean;
}): "checkpoint" | "fresh" {
	return input.ownsCheckout ? "checkpoint" : "fresh";
}

/**
 * A message's code. A turn that never touched the workspace has no code
 * point and changed nothing, so its code is what the next turn that did
 * found at its start (its code point), or, with no such turn yet, the
 * checkout as it is now (captured as a new point). A code restore in
 * between makes that later code not the message's, so the fork is refused.
 */
export async function forkCode(input: {
	readonly messageId: string;
	readonly code: ConversationPoint["code"] | undefined;
	readonly userMessageIds: readonly string[];
	readonly later: (
		laterIds: readonly string[],
	) => ReturnType<typeof laterConversationCode>;
}): Promise<NonNullable<ConversationPoint["code"]> | "now"> {
	if (input.code) return input.code;
	const index = input.userMessageIds.indexOf(input.messageId);
	if (index < 0)
		throw new RecoveryRefused(
			"This message has no code checkpoint to fork from.",
		);
	const later = await input.later(input.userMessageIds.slice(index + 1));
	if (later.rewound)
		throw new RecoveryRefused(
			"Code was restored after this message, so its code is unknown; fork from another message.",
		);
	return later.code ?? "now";
}

const FORK_BRANCH_ATTEMPTS = 6;

/** The fork's own `ytimesy/` branch; it never works on the source's branch. */
async function forkBranchName(
	session: Pick<AgentSessionRecord, "userId" | "projectId" | "title">,
	forkId: string,
) {
	let name = sessionBranchName({ title: session.title, id: forkId });
	for (let attempt = 0; attempt < FORK_BRANCH_ATTEMPTS; attempt++) {
		name = sessionBranchName({ title: session.title, id: forkId, attempt });
		if (
			!(await projectBranchHeldByOtherSession(
				session.userId,
				session.projectId,
				forkId,
				name,
			))
		)
			return name;
	}
	return name;
}

type ConversationFork = {
	readonly id: string;
	/** Null only for a fresh fork of a chat that has no base branch on record. */
	readonly branch: string | null;
	/** The VM copy still to make after the chat opens; null for a fresh fork. */
	readonly journal: ConversationForkJournal | null;
};

/**
 * Plans a fork from what the database knows, so its chat opens at once: a
 * fork of a chat with its own checkout gets a copy of that chat's VM, made
 * after the chat opens (prepareForkWorkspace); a fork of one without gets a
 * fresh checkout at its first turn. A code restore after the message is
 * refused here, before any chat is made.
 */
async function planConversationFork(
	machines: WorkspaceMachines,
	userId: string,
	input: z.infer<typeof conversationRecoveryRequest>,
): Promise<ConversationFork> {
	const id = randomUUID();
	const session = await agentSessionMetadataForOwner(userId, input.sessionId);
	if (!session || session.projectId !== input.projectId)
		throw new RecoveryRefused("Session is unavailable.");
	if (session.turnStatus === "running")
		throw new RecoveryRefused("Stop the active turn before using recovery.");
	const point = await conversationPoint(
		userId,
		input.sessionId,
		input.messageId,
	);
	if (!point)
		throw new RecoveryRefused("This message has no saved recovery point.");
	const start = forkCodeStart({
		ownsCheckout: ownsWritableCheckout({
			provider_ref: session.providerRef,
			parent_session_id: session.parentSessionId,
			agent_role: session.agentRole,
		}),
	});
	const branch = await forkBranchName(session, id);
	if (start === "fresh" || !session.providerRef)
		return {
			id,
			branch: session.baseBranch ? branch : null,
			journal: null,
		};
	if (!machinesForAgentSession(machines, session).forkWorkspace)
		throw new Error("This workspace provider cannot fork a chat's machine.");
	await resolveForkCode(userId, session, input.messageId, point);
	return {
		id,
		branch,
		journal: {
			state: "preparing",
			sourceSessionId: session.id,
			messageId: input.messageId,
			branch,
			attempt: 1,
		},
	};
}

async function resolveForkCode(
	userId: string,
	session: Pick<AgentSessionRecord, "id">,
	messageId: string,
	point: ConversationPoint,
) {
	// Only the user's messages: the rest of the transcript stays in the database.
	const userMessages =
		(
			await agentSessionItemsOfKindsForOwner(
				userId,
				[session.id],
				["userMessage"],
			)
		).get(session.id) ?? [];
	return forkCode({
		messageId,
		code: point.code,
		userMessageIds: sessionItemsFromUnknown(userMessages)
			.filter((item) => item.kind === "userMessage")
			.map((item) => item.id),
		later: (laterIds) =>
			laterConversationCode(userId, session.id, messageId, laterIds),
	});
}

/**
 * Starts copying the fork's VM without holding the caller: as a background
 * job, else after the response, else (no request around it) right here.
 */
async function startForkWorkspace(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	attempt: number,
) {
	const run = () => prepareForkWorkspace(machines, userId, sessionId, attempt);
	try {
		if (
			await dispatchBackgroundJob({
				id: backgroundJobId(`conversation-fork:${sessionId}:${attempt}`),
				kind: "conversation-fork",
				userId,
				sessionId,
				attempt,
			})
		)
			return;
	} catch {
		console.warn("Fork job dispatch failed; preparing the fork here.");
	}
	if (!startAfterResponse(run)) await run();
}

/**
 * The fork's VM is a copy of the source's (Freestyle fork: disk, ignored
 * dependencies and the never-pushed checkpoint refs), put on the fork's own
 * branch at the message's checkpoint, then bound to the fork's chat, which
 * lets its queued turn start. The source VM is only read. A failure is kept
 * on the fork's journal for its chat to show, with a retry.
 */
export async function prepareForkWorkspace(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	attempt: number,
) {
	const pending = await conversationForkJournal(userId, sessionId);
	const journal = pending?.journal;
	if (journal?.state !== "preparing" || journal.attempt !== attempt) return;
	let scoped: WorkspaceMachines | undefined;
	let vm: WorkspaceId | undefined;
	try {
		const session = await agentSessionMetadataForOwner(
			userId,
			journal.sourceSessionId,
		);
		if (!session?.providerRef)
			throw new RecoveryRefused("The original chat is no longer available.");
		scoped = machinesForAgentSession(machines, session);
		if (!scoped.forkWorkspace)
			throw new Error("This workspace provider cannot fork a chat's machine.");
		if (journal.leftoverVm)
			await scoped.destroy(WorkspaceId(journal.leftoverVm)).catch(() => {});
		const point = await conversationPoint(
			userId,
			session.id,
			journal.messageId,
		);
		if (!point)
			throw new RecoveryRefused("This message has no saved recovery point.");
		const resolved = await resolveForkCode(
			userId,
			session,
			journal.messageId,
			point,
		);
		if (resolved === "now" && session.turnStatus === "running")
			throw new RecoveryRefused(
				"The original chat is running a turn. Try again when it stops.",
			);
		const source = WorkspaceId(session.providerRef);
		await scoped.ensureRunning(source);
		const sourceCwd = (
			await scoped.readTextFile(source, PROJECT_CWD_PATH)
		)?.trim();
		if (!sourceCwd?.startsWith("/"))
			throw new Error("The chat's repository path is unavailable.");
		const code =
			resolved === "now"
				? await captureConversationCode({
						machines: scoped,
						vm: source,
						cwd: sourceCwd,
					})
				: resolved;
		if (sourceCwd !== code.cwd)
			throw new Error("Recovery point belongs to a different checkout.");
		await assertConversationCodePresent(
			{ machines: scoped, vm: source, cwd: code.cwd },
			code,
		);
		const size = await projectMachineSize(userId, session.projectId);
		// The fork's chat row already holds the slug: usage admission verifies
		// a VM's owner from the chat that holds it.
		const forking = scoped;
		vm = (
			await retryProviderCopy(() =>
				forking.forkWorkspace?.(
					source,
					agentSessionMachineSlug(sessionId),
					size,
				),
			)
		).vm;
		const cwd = (await scoped.readTextFile(vm, PROJECT_CWD_PATH))?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("The fork has no prepared repository path.");
		// As a copied session VM: the source's runtime scratch is not the fork's.
		const copy = vm;
		await Promise.all(
			copiedSessionScratchResetCommands().map((command) =>
				scoped?.exec(copy, command, 15_000),
			),
		);
		await startCheckoutFromConversationCode(
			{ machines: scoped, vm, cwd },
			code,
			journal.branch,
		);
		if (!(await bindConversationForkVm(userId, sessionId, attempt, vm))) {
			// A retry reuses the VM (it is found by its slug); only a deleted
			// chat's copy is removed.
			if (!(await agentSessionMetadataForOwner(userId, sessionId)))
				await scoped.destroy(vm).catch(() => {});
			return;
		}
	} catch (error) {
		console.warn("Preparing a forked chat failed.", forkFailureLog(error));
		let leftoverVm: string | undefined;
		if (vm && scoped)
			try {
				await scoped.destroy(vm);
			} catch {
				leftoverVm = vm;
			}
		await failConversationFork(userId, sessionId, journal, {
			message: publicRecoveryFailure(error, "fork"),
			...(leftoverVm ? { leftoverVm } : {}),
		});
		return;
	}
	await admitForkTurns();
}

/** One more try for the provider's VM copy, which a busy or recovering host can refuse once. */
const FORK_COPY_RETRY_DELAY_MS = 1_500;

/**
 * Copying the VM is the step that failed in production (2026-11-16, a
 * WorkspaceProvisionError). A retry reuses a half-made copy by its slug, so a
 * second attempt is safe; only a provisioning failure is retried.
 */
async function retryProviderCopy<T>(copy: () => Promise<T> | undefined) {
	try {
		return (await copy()) as T;
	} catch (error) {
		if (!(error instanceof WorkspaceProvisionError)) throw error;
		console.warn("Forking the machine failed once; trying again.", {
			operation: error.operation,
			detail: redactSecrets(error.detail ?? error.message, 300),
		});
		await new Promise((resolve) =>
			setTimeout(resolve, FORK_COPY_RETRY_DELAY_MS),
		);
		return (await copy()) as T;
	}
}

/**
 * What the server log keeps of a failed fork: the class, the message and a
 * provisioning error's provider detail, redacted and cut. The user still
 * sees one generic line (publicRecoveryFailure).
 */
function forkFailureLog(error: unknown) {
	if (!(error instanceof Error)) return { error: "unknown" };
	return {
		error: error.name,
		message: redactSecrets(error.message, 300),
		...(error instanceof WorkspaceProvisionError
			? {
					operation: error.operation,
					detail: redactSecrets(error.detail ?? "", 300),
				}
			: {}),
	};
}

/** A message sent while the fork was preparing waits queued; start it now. */
async function admitForkTurns() {
	if (
		configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET) !==
		"durable-object"
	)
		return;
	try {
		if (
			!(await dispatchBackgroundJob({
				id: randomUUID(),
				kind: "model-admission",
			}))
		)
			console.warn("Fork turn wake is unavailable; admission sweep starts it.");
	} catch {
		console.warn("Fork turn wake deferred; admission sweep starts it.");
	}
}

/** The fork's VM copy as its chat shows it: null when there is none pending. */
export async function conversationForkState(
	userId: string,
	projectId: string,
	sessionId: string,
) {
	const pending = await conversationForkJournal(userId, sessionId, projectId);
	return conversationForkStatus(
		pending?.journal ?? null,
		pending?.updatedAt ?? null,
		Date.now(),
	);
}

/** Retries a failed (or interrupted) VM copy; its queued turn stays queued meanwhile. */
export async function retryConversationFork(
	machines: WorkspaceMachines,
	userId: string,
	projectId: string,
	sessionId: string,
) {
	const attempt = await retryConversationForkJournal(
		userId,
		projectId,
		sessionId,
	);
	if (attempt !== null)
		await startForkWorkspace(machines, userId, sessionId, attempt);
	return conversationForkState(userId, projectId, sessionId);
}

/** Session locks exclude new turns and active descendants. A pre-restore Git point makes code replacement recoverable. */
export async function recoverConversation(
	machines: WorkspaceMachines,
	userId: string,
	request: z.infer<typeof conversationRecoveryRequest>,
) {
	const input = conversationRecoveryRequest.parse(request);
	if (input.mode === "fork" && !conversationForkEnabled())
		throw new RecoveryRefused(CONVERSATION_FORK_UNAVAILABLE);
	// A fork's chat opens with its transcript now; its VM is copied after,
	// outside the session lock (a copy can outlast the lock's idle limit, and
	// it changes nothing in the source).
	const fork =
		input.mode === "fork"
			? await planConversationFork(machines, userId, input)
			: undefined;
	const recovered = await recoverLocked(machines, userId, input, fork);
	if (fork?.journal)
		await startForkWorkspace(machines, userId, fork.id, fork.journal.attempt);
	return recovered;
}

async function recoverLocked(
	machines: WorkspaceMachines,
	userId: string,
	input: z.infer<typeof conversationRecoveryRequest>,
	fork: ConversationFork | undefined,
) {
	const client = await database().connect();
	let workspace: AgentToolWorkspace | undefined;
	let backup: Awaited<ReturnType<typeof captureConversationCode>> | undefined;
	let hold: SettledConversationTurnHold | undefined;
	try {
		await client.query("begin");
		await client.query("set local idle_in_transaction_session_timeout='120s'");
		// Locked without its transcript: the backup below copies it inside the
		// database, so it never travels to the Worker and back.
		const selected = await client.query(
			`select id,project_id,workspace_id,harness,title,listed_model_id,turn_status,
			  selected_branch,working_branch,task_branch,base_branch,provider_ref,
			  parent_session_id,agent_role
			 from agent_session where user_id=$1 and id=$2 and project_id=$3 for update`,
			[userId, input.sessionId, input.projectId],
		);
		const row = selected.rows[0];
		if (!row || row.turn_status === "running")
			throw new RecoveryRefused("Stop the active turn before using recovery.");
		const active = await client.query(
			`with recursive descendants as (
      select id from agent_session where user_id=$1 and parent_session_id=$2
      union all select s.id from agent_session s join descendants d on s.parent_session_id=d.id where s.user_id=$1
    ) select s.id,s.turn_status from agent_session s join descendants d on s.id=d.id order by s.id for update of s`,
			[userId, input.sessionId],
		);
		if (active.rows.some((child) => child.turn_status === "running"))
			throw new RecoveryRefused(
				"Stop active child tasks before using recovery.",
			);
		// turn_status turns idle before a stopped turn's runner has fully settled.
		if (input.mode !== "fork")
			hold = await holdSettledConversationTurn(userId, input.sessionId);
		const point = await conversationPoint(
			userId,
			input.sessionId,
			input.messageId,
			client,
		);
		if (!point)
			throw new RecoveryRefused("This message has no saved recovery point.");
		// Retain the current conversation before replacing it; no original API
		// turn is deleted. The transcript and the latest turn's messages are
		// copied by the database (they were read out and written back before).
		const backupId = `conversation-backup:${randomUUID()}`;
		await client.query(
			`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
			 select s.id,$2,'done',jsonb_build_object('id',$2::text,'ok',true,'result',
			   jsonb_build_object('items',s.items,'messages',coalesce(t.messages,'[]'::jsonb))
			   || case when t.model_id is null then '{}'::jsonb else jsonb_build_object('modelId',t.model_id) end
			   || case when t.connection_revision is null then '{}'::jsonb else jsonb_build_object('revision',t.connection_revision) end),
			  now()
			 from agent_session s
			 left join lateral (select messages,model_id,connection_revision from api_turn
			   where session_id=s.id and user_id=$3 order by created_at desc limit 1) t on true
			 where s.id=$1 and s.user_id=$3`,
			[input.sessionId, backupId, userId],
		);
		let id = input.sessionId;
		if (fork) {
			id = fork.id;
			// A fork has its own VM (copied at the message's code after this
			// commit, or made at its first turn), its own branch off the source's
			// base and fresh task ancestry; it cannot control source children.
			// Its row starts without a VM; a pending copy's journal holds the
			// fork's turns back until the copy is bound.
			await client.query(
				`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,turn_status,selected_branch,working_branch,base_branch)
        values($1,$2,$3,$4,$5,$6,$7,'starting','idle',$8,$9,$10)`,
				[
					id,
					userId,
					row.project_id,
					row.workspace_id,
					row.harness,
					`${row.title} (fork)`.slice(0, 120),
					row.listed_model_id,
					fork.branch ??
						row.selected_branch ??
						row.working_branch ??
						row.task_branch,
					fork.branch,
					fork.branch ? row.base_branch : null,
				],
			);
			if (fork.journal)
				await openConversationForkJournal(client, id, fork.journal);
		} else if (input.mode === "code" || input.mode === "both") {
			if (!point.code || !ownsWritableCheckout(row))
				throw new RecoveryRefused(
					"This message has no isolated writable code checkpoint.",
				);
			const session = await agentSessionMetadataForOwner(
				userId,
				input.sessionId,
			);
			if (!session) throw new RecoveryRefused("Session is unavailable.");
			const scoped = machinesForAgentSession(machines, session);
			await scoped.ensureRunning(WorkspaceId(row.provider_ref));
			workspace = {
				machines: scoped,
				vm: WorkspaceId(row.provider_ref),
				cwd: point.code.cwd,
			};
			backup = await captureConversationCode(workspace);
			// Store before mutation so an uncertain restore keeps its backup pointer in the same journal.
			await client.query(
				`update agent_task_command_receipt set response=jsonb_set(response,'{result,code}',$3::jsonb) where parent_session_id=$1 and request_id=$2`,
				[input.sessionId, backupId, jsonbText(backup)],
			);
			await restoreConversationCode(workspace, point.code, backup);
		}
		if (input.mode !== "code")
			await saveRecoveredConversation(client, userId, id, point);
		else if (row.parent_session_id)
			await client.query(
				"update agent_session set task_review_state='pending',updated_at=now() where id=$1 and user_id=$2",
				[id, userId],
			);
		// The code is in place: confirm no stopped runner could have reclaimed the
		// chat meanwhile, then free it before committing. A new turn's runner
		// waits on the committed session row, so it never sees the hold.
		hold?.assertHeld();
		await hold?.release();
		await client.query("commit");
		// The restored transcript lets the chat show it at once, without
		// waiting on a full reload of the session.
		return input.mode === "code"
			? { id, prompt: null, items: null }
			: {
					id,
					prompt: point.prompt,
					items: sessionItemsFromUnknown(point.items),
				};
	} catch (error) {
		// Never overwrite concurrent terminal edits during error handling. Git backup refs
		// survive rollback and can be restored even if a remote response is uncertain.
		await client.query("rollback");
		throw error;
	} finally {
		const released = hold?.release();
		client.release();
		await released;
	}
}

export async function listConversationRecoveryPoints(
	userId: string,
	projectId: string,
	sessionId: string,
) {
	const { rows } = await database().query(
		`select r.point_message_id as "messageId", r.point_has_code as "codeAvailable" from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
    where s.user_id=$1 and s.project_id=$2 and s.id=$3 and r.request_id like 'conversation-point:%' and r.status='done'
    -- A point whose stored body has expired (30 days, the bucket's rule) is no longer offered.
    and not (r.created_at < now() - interval '30 days'
      and coalesce(r.response->'result'->>'messagesObject', r.response->'result'->>'bodyObject', '') like 'points/%')
    order by r.created_at desc limit 100`,
		[userId, projectId, sessionId],
	);
	const forkAvailable = conversationForkEnabled();
	return rows.map(
		({
			messageId,
			codeAvailable,
		}: {
			messageId: string;
			codeAvailable: boolean;
		}) => ({ messageId, codeAvailable, forkAvailable }),
	);
}
