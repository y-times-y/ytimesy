import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { database } from "../adapters/database";
import { harnessVariantForUser } from "../adapters/dev-eval-users";
import { enqueueAgentTaskEvent } from "../jobs/queue";
import { subagentReport } from "./subagent-runtime";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * How long a finished child turn is left to its own runtime before its
 * event is recovered. The runtime saves the report after the turn row is
 * final, and a writer's report first transfers its patch (seconds); a
 * recovery inside that window saved the bare final text under the same
 * dedupe key, so the parent never saw the patch (found by the rehearsal).
 */
export const CHILD_EVENT_RECOVERY_GRACE_SECONDS = 120;

/**
 * A subagent's settled turn whose report never reached its parent (a crash
 * between finalizing the turn and saving the event) is reported here, with
 * the same header and writer patch as a live report.
 */
export async function recoverChildTurnEvents(machines: WorkspaceMachines) {
	const result = await database().query<{
		id: string;
		session_id: string;
		user_id: string;
		state: "completed" | "failed";
		items: unknown;
	}>(
		`select t.id,t.session_id,c.user_id,t.state,case when jsonb_typeof(t.items)='array' then t.items else c.items end as items from agent_session c
		 cross join lateral (select l.* from api_turn l where l.session_id=c.id and l.user_id=c.user_id
		   order by l.created_at desc limit 1) t
		 where c.parent_session_id is not null and c.agent_role is not null and t.state in ('completed','failed')
		 and t.updated_at < now() - make_interval(secs => $1)
		 and not exists(select 1 from agent_task_event e where e.child_session_id=c.id and
		   (e.dedupe_key=c.id::text || ':' || t.state || ':' || t.id::text or e.created_at>=t.updated_at))
		 order by t.updated_at limit 32`,
		[CHILD_EVENT_RECOVERY_GRACE_SECONDS],
	);
	for (const turn of result.rows) {
		const items = sessionItemsFromUnknown(turn.items);
		let lastUser = items.length - 1;
		while (lastUser >= 0 && items[lastUser].kind !== "userMessage") lastUser--;
		const current = items.slice(lastUser + 1);
		const text =
			turn.state === "failed"
				? current
						.filter((item) => item.kind === "error")
						.map((item) => item.message)
						.join("\n") ||
					"The worker disconnected. Inspect the subagent's work before relying on it; uncertain tools were not replayed."
				: current
						.filter((item) => item.kind === "agentMessage")
						.map((item) => item.text)
						.join("\n")
						.slice(-9000) || "(no final report)";
		const session = await agentSessionMetadataForOwner(
			turn.user_id,
			turn.session_id,
		);
		if (!session) continue;
		const variant = await harnessVariantForUser(turn.user_id).catch(() => null);
		const summary = await subagentReport({
			machines,
			session,
			items,
			outcome: turn.state === "failed" ? "failed" : "finished",
			text,
			thinLead: variant?.lead === "fusion" && variant.leadTools === "thin",
		}).catch(() => text);
		const id = await saveAgentTaskResultAndEvent({
			sessionId: turn.session_id,
			turnId: turn.id,
			eventType: turn.state,
			summary: summary.slice(-16000),
		});
		if (id) await enqueueAgentTaskEvent(id).catch(() => {});
	}
}
