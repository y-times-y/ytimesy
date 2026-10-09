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
	const capacity = await agentCapacity(userId);
	const content = `${PREFIX}${JSON.stringify(tasks.rows)}\nExecution capacity: at most ${capacity.maxChildren} active children per parent; ${capacity.available} additional slots available across the worker fleet and your account, subject to that per-parent limit. This is a current snapshot, not a reservation. start_task atomically checks capacity before dispatch; rejected tasks stay unstarted. Do not plan more simultaneous children than this limit. Reuse or steer existing tasks for the same objective. Do not create replacement children just because a turn ended or a task is queued. Parallel children should have distinct bounded objectives unless the user explicitly requests competing implementations. The newest delegated-task snapshot supersedes earlier snapshots; earlier entries describe historical status only.`;
	if (latest?.content === content) return messages;
	return [
		...messages,
		{
			role: "user",
			content,
		},
	];
}
