import { createHash } from "node:crypto";
import { childSupervisionSlot } from "#/domain/child-supervision";
import { childTaskEventQueueText } from "#/domain/child-task-activity";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { database } from "../adapters/database";
import { serverPeerMessageAccepted } from "../adapters/server-peer-inbox";
import { enqueueAgentTaskEvent } from "../jobs/queue";
import { deliverParentTaskNotification } from "./agent-task-event-delivery";
import type { WorkspaceMachines } from "./workspace-machines";

/** Recover settled server turns even after a crash between finalization and notification. */
export async function recoverChildTurnEvents() {
	const result = await database().query<{
		id: string;
		session_id: string;
		state: "completed" | "failed";
		items: unknown;
	}>(
		`select t.id,t.session_id,t.state,t.items from api_turn t
		 join agent_session c on c.id=t.session_id and c.user_id=t.user_id
		 where c.parent_session_id is not null and t.state in ('completed','failed')
		 and not exists(select 1 from api_turn newer where newer.session_id=t.session_id and newer.created_at>t.created_at)
		 and not exists(select 1 from agent_task_event e where e.child_session_id=c.id and
		   (e.dedupe_key=c.id::text || ':' || t.state || ':' || t.id::text or e.created_at>=t.updated_at))
		 order by t.updated_at limit 32`,
	);
	for (const turn of result.rows) {
		const items = sessionItemsFromUnknown(turn.items);
		let lastUser = items.length - 1;
		while (lastUser >= 0 && items[lastUser].kind !== "userMessage") lastUser--;
		const current = items.slice(lastUser + 1);
		const summary =
			turn.state === "failed"
				? current
						.filter((item) => item.kind === "error")
						.map((item) => item.message)
						.join("\n") ||
					"The worker disconnected. Inspect the child before retrying; uncertain tools were not replayed."
				: current
						.filter((item) => item.kind === "agentMessage")
						.map((item) => item.text)
						.join("\n") ||
					"The child completed without a recorded summary. Inspect its evidence before accepting.";
		const id = await saveAgentTaskResultAndEvent({
			sessionId: turn.session_id,
			turnId: turn.id,
			eventType: turn.state,
			summary: summary.slice(-16000),
		});
		if (id) await enqueueAgentTaskEvent(id).catch(() => {});
	}
}

/** Uses the existing mailbox receipts to cap check-ins across worker restarts. */
export async function superviseAgentChildren(
	machines: WorkspaceMachines,
	now = Date.now(),
) {
	const result = await database().query<{
		id: string;
		user_id: string;
		parent_session_id: string;
		title: string;
		items: unknown;
		turn_id: string | null;
		started_at: Date | null;
		updated_at: Date;
	}>(
		`select c.id,c.user_id,c.parent_session_id,c.title,c.items,t.id as turn_id,t.created_at as started_at,c.updated_at
		 from agent_session c left join api_turn t on c.id=t.session_id and c.user_id=t.user_id and t.state='running' and not t.cancel_requested
		 join agent_session p on p.id=c.parent_session_id and p.user_id=c.user_id and p.project_id=c.project_id
		 where c.turn_status='running' and c.candidate_index is null
		 and (t.id is not null or c.harness not in ('api','codex'))
		 order by coalesce(t.created_at,c.updated_at) limit 32`,
	);
	for (const child of result.rows) {
		const prompt = sessionItemsFromUnknown(child.items)
			.filter((item) => item.kind === "userMessage")
			.at(-1);
		const startedAt = child.started_at
			? new Date(child.started_at).getTime()
			: prompt?.timing?.startedAt;
		if (startedAt == null) continue;
		const turnId =
			child.turn_id ??
			createHash("sha256")
				.update(`${child.id}:${prompt?.id}:${startedAt}`)
				.digest("hex")
				.slice(0, 32);
		const slot = childSupervisionSlot(
			startedAt,
			new Date(child.updated_at).getTime(),
			now,
		);
		if (!slot) continue;
		const id = `supervision-${turnId}-${slot}`;
		if (await serverPeerMessageAccepted(child.parent_session_id, id)) continue;
		const [parent, current] = await Promise.all([
			agentSessionForOwner(child.user_id, child.parent_session_id),
			agentSessionForOwner(child.user_id, child.id),
		]);
		if (
			!parent ||
			!current ||
			current.turnStatus !== "running" ||
			current.parentSessionId !== parent.id ||
			current.projectId !== parent.projectId
		)
			continue;
		await deliverParentTaskNotification(
			machines,
			parent,
			id,
			`${childTaskEventQueueText(id)}\nSupervisor check-in: ${child.title} (${child.id}) has been running for ${Math.floor((now - startedAt) / 60000)} minutes. This is not evidence of failure. Read its recent activity and status; if it is stalled, drifting, or needs a decision, send_task_message to request a concise progress summary or steer it. Do not create a replacement child merely because it is slow, interrupt healthy work, or paste this internal notification to the user. Continue useful investigation and review finished results.`,
		).catch(() => {});
	}
}
