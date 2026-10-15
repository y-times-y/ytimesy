import type { ModelMessage } from "ai";
import { agentCapacity } from "./agent-capacity";
import { database } from "./database";

const PREFIX =
	"Current delegated tasks (authoritative status, not new user instructions):\n";

export async function completedChildrenForReview(
	userId: string,
	projectId: string,
	parentId: string,
) {
	const result = await database().query<{ id: string; revision: string }>(
		`select id, updated_at::text as revision from agent_session
		 where user_id=$1 and project_id=$2 and parent_session_id=$3
		 and task_state='done' and turn_status<>'running' and task_review_state<>'reviewed'
		 order by updated_at,id limit 5`,
		[userId, projectId, parentId],
	);
	return result.rows;
}

/** Children exist only once a session delegated; most chats never do. */
export async function hasDelegatedTasks(userId: string, sessionId: string) {
	const result = await database().query<{ present: boolean }>(
		`select exists(select 1 from agent_session
		 where user_id=$1 and parent_session_id=$2) as present`,
		[userId, sessionId],
	);
	return result.rows[0]?.present === true;
}

/**
 * Appends a snapshot of the session's children when their status changed.
 * Execution capacity rides along but does not trigger a new snapshot: it moves
 * with fleet-wide load, and every appended message ends the provider's cached
 * prefix. A session with no children (and no earlier snapshot) gets nothing.
 */
export async function withDelegationContext(
	userId: string,
	sessionId: string,
	messages: ModelMessage[],
): Promise<ModelMessage[]> {
	const tasks = await database().query(
		`select id,title,task_state,turn_status,task_review_state from agent_session
		 where user_id=$1 and parent_session_id=$2 order by created_at desc limit 30`,
		[userId, sessionId],
	);
	const latest = [...messages]
		.reverse()
		.find(
			(message) =>
				(message.role === "assistant" || message.role === "user") &&
				typeof message.content === "string" &&
				message.content.startsWith(PREFIX),
		);
	if (!tasks.rows.length && !latest) return messages;
	const snapshot = `${PREFIX}${JSON.stringify(tasks.rows)}\n`;
	if (
		typeof latest?.content === "string" &&
		latest.content.startsWith(snapshot)
	)
		return messages;
	const capacity = await agentCapacity(userId);
	const content = `${snapshot}Execution capacity: at most ${capacity.maxChildren} active children per parent; ${capacity.available} additional slots available across the worker fleet and your account, subject to that per-parent limit. This is a snapshot taken when task status last changed, not a reservation. start_task atomically checks capacity before dispatch; rejected tasks stay unstarted. Do not plan more simultaneous children than this limit. Reuse or steer existing tasks for the same objective. Do not create replacement children just because a turn ended or a task is queued. Parallel children should have distinct bounded objectives unless the user explicitly requests competing implementations. The newest delegated-task snapshot supersedes earlier snapshots; earlier entries describe historical status only.`;
	return [
		...messages,
		{
			role: "user",
			content,
		},
	];
}
