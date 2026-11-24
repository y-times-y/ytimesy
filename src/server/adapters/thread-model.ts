import type { AgentProviderId } from "#/domain/agent-provider";
import { SessionItemId } from "#/domain/ids";
import { jsonbText } from "#/domain/jsonb";
import type { SessionItem } from "#/domain/session-item";
import { wakeConversationProgress } from "./conversation-progress-wake";
import { database } from "./database";
import { forgetPeerInboxObservation } from "./peer-inbox-observation";

export type ThreadModelChange = {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId: string;
	/** The route id the send path takes. */
	readonly modelId: string;
	readonly harness: AgentProviderId;
	readonly variant?: string;
	readonly speed?: "fast" | "ultrafast";
	/** The quiet line for the thread's transcript. */
	readonly line: string;
	/** Makes the line's id stable: a replayed change adds it once. */
	readonly changeId: string;
};

/**
 * Points one of the person's threads at another model from its next turn.
 *
 * The thread's model is `listed_model_id` (every turn start rewrites it, and
 * runtime sends such as a pull request wake or an answered question read it);
 * its harness stays as it is, because the next send is what switches a chat
 * between runtimes and carries the conversation over (the send path takes the
 * harness from the model's id, harnessForModelId). Messages already waiting in
 * the thread move to the new model too, so "the next turn" is the new one
 * whoever starts it.
 *
 * The quiet line goes into an idle thread's transcript in the same statement;
 * a running turn owns its timeline, so there the model changes and the line is
 * left out (`lineWritten` false). Only a root thread of the project that is not
 * Y² itself and not a helper chat changes.
 */
export async function setThreadModel(
	change: ThreadModelChange,
): Promise<{ found: boolean; lineWritten: boolean }> {
	const line: SessionItem = {
		kind: "notice",
		id: SessionItemId(`${change.sessionId}:model-change:${change.changeId}`),
		message: change.line,
	};
	const queued = {
		harnessId: change.harness,
		modelId: change.modelId,
		...(change.variant ? { variant: change.variant } : {}),
		...(change.speed
			? change.harness === "codex"
				? { fast: true }
				: { speed: change.speed }
			: {}),
	};
	const result = await database().query<{
		found: number;
		line: boolean | null;
	}>(
		`/* setThreadModel */ with target as (
		   select id, turn_status from agent_session
		   where id=$1 and user_id=$2 and project_id=$3 and parent_session_id is null
		     and agent_role is null and chat_role is distinct from 'y2'
		   for update),
		 changed as (
		   update agent_session s set listed_model_id=$4, updated_at=now(),
		     items=case when t.turn_status <> 'running'
		       and not coalesce(s.items,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id',$7::text))
		       then coalesce(s.items,'[]'::jsonb)||$5::jsonb else s.items end
		   from target t where s.id=t.id returning t.turn_status as before),
		 waiting as (
		   update agent_peer_inbox q
		   set queued_send=(q.queued_send - 'variant' - 'speed' - 'fast' - 'alternateContext')||$6::jsonb
		   where q.recipient_id in (select id from target) and not q.accepted and q.queued_send is not null
		   returning q.id)
		 select (select count(*) from changed)::int as found,
		        (select bool_or(before <> 'running') from changed) as line`,
		[
			change.sessionId,
			change.userId,
			change.projectId,
			change.modelId,
			jsonbText([line]),
			jsonbText(queued),
			line.id,
		],
	);
	const row = result.rows[0];
	if (!row?.found) return { found: false, lineWritten: false };
	forgetPeerInboxObservation(change.sessionId);
	await wakeConversationProgress().catch(() => undefined);
	return { found: true, lineWritten: row.line === true };
}
