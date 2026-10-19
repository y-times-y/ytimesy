import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkspaceId } from "#/domain/ids";
import { jsonbText } from "#/domain/jsonb";
import { type SubagentRole, writesOwnCheckout } from "#/domain/subagent";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	conversationPoint,
	saveRecoveredConversation,
} from "../adapters/conversation-recovery";
import { database } from "../adapters/database";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	captureConversationCode,
	restoreConversationCode,
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

/** Session locks exclude new turns and active descendants. A pre-restore Git point makes code replacement recoverable. */
export async function recoverConversation(
	machines: WorkspaceMachines,
	userId: string,
	request: z.infer<typeof conversationRecoveryRequest>,
) {
	const input = conversationRecoveryRequest.parse(request);
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
			throw new Error("Stop the active turn before using recovery.");
		const active = await client.query(
			`with recursive descendants as (
      select id from agent_session where user_id=$1 and parent_session_id=$2
      union all select s.id from agent_session s join descendants d on s.parent_session_id=d.id where s.user_id=$1
    ) select s.id,s.turn_status from agent_session s join descendants d on s.id=d.id order by s.id for update of s`,
			[userId, input.sessionId],
		);
		if (active.rows.some((child) => child.turn_status === "running"))
			throw new Error("Stop active child tasks before using recovery.");
		// turn_status turns idle before a stopped turn's runner has fully settled.
		if (input.mode !== "fork")
			hold = await holdSettledConversationTurn(userId, input.sessionId);
		const point = await conversationPoint(
			userId,
			input.sessionId,
			input.messageId,
			client,
		);
		if (!point) throw new Error("This message has no saved recovery point.");
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
		if (input.mode === "fork") {
			id = randomUUID();
			// A fork has an independent lazy workspace and fresh task ancestry; it cannot control source children.
			await client.query(
				`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,turn_status,selected_branch)
        values($1,$2,$3,$4,$5,$6,$7,'starting','idle',$8)`,
				[
					id,
					userId,
					row.project_id,
					row.workspace_id,
					row.harness,
					`${row.title} (fork)`.slice(0, 120),
					row.listed_model_id,
					row.selected_branch ?? row.working_branch ?? row.task_branch,
				],
			);
		} else if (input.mode === "code" || input.mode === "both") {
			if (!point.code || !ownsWritableCheckout(row))
				throw new Error(
					"This message has no isolated writable code checkpoint.",
				);
			const session = await agentSessionForOwner(userId, input.sessionId);
			if (!session) throw new Error("Session is unavailable.");
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
		return { id, prompt: input.mode === "code" ? null : point.prompt };
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
