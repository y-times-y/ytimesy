import type { AttemptLoopState } from "#/domain/attempt-loop";
import { jsonbText } from "#/domain/jsonb";
import { database } from "./database";

/**
 * The attempt loop's durable state, one row per root turn in the session's
 * receipt journal (agent_task_command_receipt, no schema change): it
 * survives step boundaries and executor restarts, cascades with the session
 * and is readable by the eval runners before they delete the session.
 */

const stateRequestId = (turnId: string) => `attempt-loop:${turnId}`;
/** An eval runner's deadline for the whole loop (it can only shorten the product default). */
const DEADLINE_REQUEST_ID = "attempt-loop-deadline";

export async function loadAttemptLoopState(
	sessionId: string,
	turnId: string,
): Promise<AttemptLoopState | null> {
	const { rows } = await database().query(
		`select response from agent_task_command_receipt
		 where parent_session_id=$1 and request_id=$2 and status='done'`,
		[sessionId, stateRequestId(turnId)],
	);
	const state = rows[0]?.response as AttemptLoopState | undefined;
	return state?.version === 1 ? state : null;
}

export async function saveAttemptLoopState(
	sessionId: string,
	state: AttemptLoopState,
) {
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 values($1,$2,'done',$3::jsonb,now())
		 on conflict (parent_session_id,request_id)
		 do update set response=excluded.response, updated_at=now()`,
		[sessionId, stateRequestId(state.turnId), jsonbText(state)],
	);
}

/** Every loop of a session, oldest first (the hard-set runner's record). */
export async function attemptLoopStates(
	sessionId: string,
): Promise<AttemptLoopState[]> {
	const { rows } = await database().query(
		`select response from agent_task_command_receipt
		 where parent_session_id=$1 and request_id like 'attempt-loop:%' and status='done'
		 order by created_at`,
		[sessionId],
	);
	return rows
		.map((row) => row.response as AttemptLoopState)
		.filter((state) => state?.version === 1);
}

export async function saveAttemptLoopDeadline(
	sessionId: string,
	deadlineAt: number,
) {
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 values($1,$2,'done',$3::jsonb,now())
		 on conflict (parent_session_id,request_id)
		 do update set response=excluded.response, updated_at=now()`,
		[sessionId, DEADLINE_REQUEST_ID, JSON.stringify({ deadlineAt })],
	);
}

export async function attemptLoopDeadline(sessionId: string) {
	const { rows } = await database().query(
		`select response->>'deadlineAt' as deadline from agent_task_command_receipt
		 where parent_session_id=$1 and request_id=$2 and status='done'`,
		[sessionId, DEADLINE_REQUEST_ID],
	);
	const value = Number(rows[0]?.deadline);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Takes a runtime-started subagent's final report for the loop and keeps it
 * out of the builder's conversation: the event is marked delivered and a
 * copy staged in the parent's inbox (while the parent's turn ran) is removed.
 */
export async function takeLoopSubagentReport(
	parentSessionId: string,
	childSessionId: string,
) {
	const result = await database().query(
		`update agent_task_event set status='delivered', delivered_at=now(), last_error=null
		 where child_session_id=$1 and status in ('pending','delivering') and event_type in ('completed','failed')
		 returning id, event_type, payload`,
		[childSessionId],
	);
	const row = result.rows[0] as
		| {
				id: string;
				event_type: "completed" | "failed";
				payload: { message?: unknown };
		  }
		| undefined;
	if (!row) return null;
	await database().query(
		"delete from agent_peer_inbox where recipient_id=$1 and id=$2 and not accepted",
		[parentSessionId, row.id],
	);
	return {
		outcome: row.event_type,
		report: typeof row.payload?.message === "string" ? row.payload.message : "",
	};
}

/** The child's own state, for a report that never arrives (a crashed child). */
export async function loopSubagentStatus(childSessionId: string) {
	const { rows } = await database().query(
		"select turn_status, items from agent_session where id=$1",
		[childSessionId],
	);
	const row = rows[0] as { turn_status: string; items: unknown } | undefined;
	return row ? { turnStatus: row.turn_status, items: row.items } : null;
}
