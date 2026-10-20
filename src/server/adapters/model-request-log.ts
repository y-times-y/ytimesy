import { jsonbText } from "#/domain/jsonb";
import { database } from "./database";

/**
 * Development evals only (dev_eval_user): what each model request offered,
 * so a transcript can tell a tool that was not offered from one the model
 * ignored. Kept in the session's receipt journal (agent_task_command_receipt,
 * no schema change) like the loops' state: it cascades with the session and
 * the hard-set runner reads it before deleting the session. Each distinct
 * system prompt + tool list is stored once under its hash; each request
 * stores the hash and its tool names.
 */

export type ModelRequestTool = {
	readonly name: string;
	readonly type: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	/** A provider-hosted tool's id, e.g. openai.web_search. */
	readonly id?: string;
};

export type ModelRequestBody = {
	readonly version: 1;
	readonly instructions: string;
	readonly tools: readonly ModelRequestTool[];
};

export type ModelRequestRecord = {
	readonly version: 1;
	readonly turnId: string;
	/** The durable step (1-based), or 0 for a turn run in one invocation. */
	readonly step: number;
	/** The model call within that step, from 0. */
	readonly call: number;
	readonly at: string;
	readonly hash: string;
	readonly tools: readonly string[];
};

const requestId = (record: ModelRequestRecord) =>
	`model-request:${record.turnId}:${String(record.step).padStart(4, "0")}:${String(record.call).padStart(3, "0")}`;
const bodyRequestId = (hash: string) => `model-request-body:${hash}`;

export async function saveModelRequest(
	sessionId: string,
	record: ModelRequestRecord,
	body: ModelRequestBody,
) {
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 values($1,$2,'done',$3::jsonb,now()),($1,$4,'done',$5::jsonb,now())
		 on conflict (parent_session_id,request_id)
		 do update set response=excluded.response, updated_at=now()`,
		[
			sessionId,
			bodyRequestId(record.hash),
			jsonbText(body),
			requestId(record),
			jsonbText(record),
		],
	);
}

/**
 * A session's requests and those of its subagents (the checker included),
 * oldest first, with each distinct prompt and tool list once.
 */
export async function modelRequestLog(rootSessionId: string): Promise<{
	requests: (ModelRequestRecord & { sessionId: string })[];
	bodies: Record<string, ModelRequestBody>;
}> {
	const { rows } = await database().query<{
		session_id: string;
		request_id: string;
		response: unknown;
	}>(
		`select r.parent_session_id as session_id,r.request_id,r.response
		 from agent_task_command_receipt r
		 where r.parent_session_id in (
		   select id from agent_session where id=$1 or parent_session_id=$1)
		 and (r.request_id like 'model-request:%' or r.request_id like 'model-request-body:%')
		 and r.status='done'
		 order by r.created_at, r.request_id`,
		[rootSessionId],
	);
	const requests: (ModelRequestRecord & { sessionId: string })[] = [];
	const bodies: Record<string, ModelRequestBody> = {};
	for (const row of rows) {
		const response = row.response as { version?: unknown } | null;
		if (response?.version !== 1) continue;
		if (row.request_id.startsWith("model-request-body:"))
			bodies[row.request_id.slice("model-request-body:".length)] =
				response as ModelRequestBody;
		else
			requests.push({
				...(response as ModelRequestRecord),
				sessionId: row.session_id,
			});
	}
	return { requests, bodies };
}
