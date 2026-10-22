import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	agentSessionMachineSlug,
	copiedSessionScratchResetCommands,
} from "#/domain/agent-session";
import { RecoveryRefused } from "#/domain/conversation-recovery-failure";
import { WorkspaceId } from "#/domain/ids";
import { jsonbText } from "#/domain/jsonb";
import { sessionBranchName } from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { type SubagentRole, writesOwnCheckout } from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	projectBranchHeldByOtherSession,
} from "../adapters/agent-sessions";
import {
	type ConversationPoint,
	conversationPoint,
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
	const point = await conversationPoint(userId, sessionId, messageId);
	if (!point || point.code) return;
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
	readonly vm: WorkspaceId | null;
	/** Its chat row was made before its VM (the VM's usage owner); recovery completes it. */
	readonly reserved: boolean;
	readonly destroy: () => Promise<void>;
};

/**
 * Makes the fork's chat row before its VM is created: usage admission
 * verifies a VM's owner from the chat that holds its slug, so a VM for a
 * chat that does not exist yet has no owner and is refused. The row starts
 * like a fork that has no VM yet; recovery binds the VM to it.
 */
async function reserveForkSession(
	session: AgentSessionRecord,
	id: string,
	branch: string,
) {
	await database().query(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,turn_status,selected_branch,working_branch,base_branch)
		 values($1,$2,$3,$4,$5,$6,$7,'starting','idle',$8,$8,$9)`,
		[
			id,
			session.userId,
			session.projectId,
			session.workspaceId,
			session.harness,
			`${session.title} (fork)`.slice(0, 120),
			session.listedModelId,
			branch,
			session.baseBranch ?? null,
		],
	);
}

/** Removes a fork's reserved chat row; it never held a turn or a VM. */
async function releaseForkSession(userId: string, id: string) {
	await database().query(
		"delete from agent_session where id=$1 and user_id=$2 and provider_ref is null",
		[id, userId],
	);
}

/**
 * A fork's VM that could not be deleted stays bound to its reserved chat,
 * marked failed, so it keeps a verifiable owner and is cleaned up with it.
 */
async function keepFailedForkMachine(userId: string, id: string, vm: string) {
	await database().query(
		"update agent_session set provider_ref=$3,status='failed',updated_at=now() where id=$1 and user_id=$2 and provider_ref is null",
		[id, userId, vm],
	);
}

/**
 * The fork's VM is a copy of the source's (Freestyle fork: disk, ignored
 * dependencies and the never-pushed checkpoint refs), put on the fork's own
 * branch at the message's checkpoint. The source VM is only read.
 */
async function prepareConversationFork(
	machines: WorkspaceMachines,
	userId: string,
	input: z.infer<typeof conversationRecoveryRequest>,
): Promise<ConversationFork> {
	const id = randomUUID();
	const session = await agentSessionForOwner(userId, input.sessionId);
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
	const none = async () => {};
	if (start === "fresh" || !session.providerRef)
		return {
			id,
			branch: session.baseBranch ? branch : null,
			vm: null,
			reserved: false,
			destroy: none,
		};
	const scoped = machinesForAgentSession(machines, session);
	if (!scoped.forkWorkspace)
		throw new Error("This workspace provider cannot fork a chat's machine.");
	const resolved = await forkCode({
		messageId: input.messageId,
		code: point.code,
		userMessageIds: sessionItemsFromUnknown(session.items)
			.filter((item) => item.kind === "userMessage")
			.map((item) => item.id),
		later: (laterIds) =>
			laterConversationCode(userId, input.sessionId, input.messageId, laterIds),
	});
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
	await reserveForkSession(session, id, branch);
	let forked: Awaited<ReturnType<typeof scoped.forkWorkspace>>;
	try {
		forked = await scoped.forkWorkspace(
			source,
			agentSessionMachineSlug(id),
			size,
		);
	} catch (error) {
		await releaseForkSession(userId, id).catch(() => {});
		throw error;
	}
	const vm = forked.vm;
	const destroy = async () => {
		try {
			await scoped.destroy(vm);
		} catch {
			await keepFailedForkMachine(userId, id, vm).catch(() => {});
			return;
		}
		await releaseForkSession(userId, id).catch(() => {});
	};
	try {
		const cwd = (
			await scoped.readTextFile(forked.vm, PROJECT_CWD_PATH)
		)?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("The fork has no prepared repository path.");
		// As a copied session VM: the source's runtime scratch is not the fork's.
		await Promise.all(
			copiedSessionScratchResetCommands().map((command) =>
				scoped.exec(forked.vm, command, 15_000),
			),
		);
		await startCheckoutFromConversationCode(
			{ machines: scoped, vm: forked.vm, cwd },
			code,
			branch,
		);
	} catch (error) {
		await destroy();
		throw error;
	}
	return { id, branch, vm: forked.vm, reserved: true, destroy };
}

/** Session locks exclude new turns and active descendants. A pre-restore Git point makes code replacement recoverable. */
export async function recoverConversation(
	machines: WorkspaceMachines,
	userId: string,
	request: z.infer<typeof conversationRecoveryRequest>,
) {
	const input = conversationRecoveryRequest.parse(request);
	// The fork's VM is copied before the session lock: a copy can outlast
	// the lock transaction's idle limit, and it changes nothing in the source.
	const fork =
		input.mode === "fork"
			? await prepareConversationFork(machines, userId, input)
			: undefined;
	try {
		return await recoverLocked(machines, userId, input, fork);
	} catch (error) {
		await fork?.destroy();
		throw error;
	}
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
		const selected = await client.query(
			`select * from agent_session where user_id=$1 and id=$2 and project_id=$3 for update`,
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
		// Retain the current conversation before replacing it; no original API turn is deleted.
		const current = await client.query(
			`select messages,model_id,connection_revision from api_turn where session_id=$1 and user_id=$2 order by created_at desc limit 1`,
			[input.sessionId, userId],
		);
		const backupId = `conversation-backup:${randomUUID()}`;
		await client.query(
			`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at) values($1,$2,'done',$3::jsonb,now())`,
			[
				input.sessionId,
				backupId,
				jsonbText({
					id: backupId,
					ok: true,
					result: {
						items: row.items,
						messages: current.rows[0]?.messages ?? [],
						modelId: current.rows[0]?.model_id,
						revision: current.rows[0]?.connection_revision,
					},
				}),
			],
		);
		let id = input.sessionId;
		if (fork) {
			id = fork.id;
			// A fork has its own VM (copied at the message's code, or made at its
			// first turn), its own branch off the source's base and fresh task
			// ancestry; it cannot control source children. A fork with a VM
			// already has its row (made before the VM); it is completed here.
			const values = [
				id,
				userId,
				row.project_id,
				row.workspace_id,
				row.harness,
				`${row.title} (fork)`.slice(0, 120),
				row.listed_model_id,
				fork.vm ? "ready" : "starting",
				fork.branch ??
					row.selected_branch ??
					row.working_branch ??
					row.task_branch,
				fork.branch,
				fork.branch ? row.base_branch : null,
				fork.vm,
			];
			if (fork.reserved) {
				const completed = await client.query(
					`update agent_session set project_id=$3,workspace_id=$4,harness=$5,title=$6,listed_model_id=$7,status=$8,
					 selected_branch=$9,working_branch=$10,base_branch=$11,provider_ref=$12,updated_at=now()
					 where id=$1 and user_id=$2 and provider_ref is null and turn_status <> 'running' and parent_session_id is null`,
					values,
				);
				if (completed.rowCount !== 1)
					throw new RecoveryRefused(
						"The fork changed while it was being prepared.",
					);
			} else
				await client.query(
					`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,turn_status,selected_branch,working_branch,base_branch,provider_ref)
        values($1,$2,$3,$4,$5,$6,$7,$8,'idle',$9,$10,$11,$12)`,
					values,
				);
		} else if (input.mode === "code" || input.mode === "both") {
			if (!point.code || !ownsWritableCheckout(row))
				throw new RecoveryRefused(
					"This message has no isolated writable code checkpoint.",
				);
			const session = await agentSessionForOwner(userId, input.sessionId);
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
		`select r.response->'result' as point from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
    where s.user_id=$1 and s.project_id=$2 and s.id=$3 and r.request_id like 'conversation-point:%' and r.status='done' order by r.created_at desc limit 100`,
		[userId, projectId, sessionId],
	);
	return rows.map(
		({ point }: { point: { userMessageId: string; code?: unknown } }) => ({
			messageId: point.userMessageId,
			codeAvailable: !!point.code,
		}),
	);
}
