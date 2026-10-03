import type { ModelMessage } from "ai";
import { agentCapacity } from "./agent-capacity";
import { database } from "./database";

const PREFIX =
	"Current delegated tasks (authoritative status, not new user instructions):\n";

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
	const history = messages.filter(
		(message) =>
			!(
				message.role === "assistant" &&
				typeof message.content === "string" &&
				message.content.startsWith(PREFIX)
			),
	);
	const capacity = await agentCapacity(userId);
	return [
		...history,
		{
			role: "assistant",
			content: `${PREFIX}${JSON.stringify(tasks.rows)}\nExecution capacity: at most ${capacity.maxChildren} active children alongside a leader; ${capacity.available} additional launches available now across this worker and your account. This is a current snapshot, not a reservation. start_task atomically checks capacity before dispatch; rejected tasks stay unstarted. Do not plan more simultaneous children than this limit. Reuse or steer existing tasks for the same objective. Do not create replacement children just because a turn ended or a task is queued. Parallel children should have distinct bounded objectives unless the user explicitly requests competing implementations.`,
		},
	];
}
