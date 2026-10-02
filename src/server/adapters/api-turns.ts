import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { database } from "./database";

export type ApiTurn = {
	id: string;
	session_id: string;
	user_id: string;
	connection_id: string | null;
	connection_revision: string;
	model_id: string;
	state: "queued" | "running" | "completed" | "failed" | "cancelled";
	messages: ModelMessage[];
	items: SessionItem[];
	lease_id: string | null;
};

export async function enqueueApiTurn(input: {
	sessionId: string;
	userId: string;
	connectionId: string | null;
	revision: string;
	modelId: string;
	routeId: string;
	messages: ModelMessage[];
	items: readonly SessionItem[];
	preparedTask?: boolean;
}) {
	const client = await database().connect();
	try {
		await client.query("begin");
		const subscription = subscriptionTurnSettings(input.revision);
		if (subscription && input.connectionId !== null)
			throw new Error("Subscription turns cannot use an API connection.");
		const connection = subscription
			? await client.query(
					"select 1 from agent_account where user_id=$1 and provider='codex' and status='connected' and encrypted_codex_auth is not null for share",
					[input.userId],
				)
			: await client.query(
					"select id from model_connection where id=$1 and user_id=$2 and revision=$3 for share",
					[input.connectionId, input.userId, input.revision],
				);
		if (!connection.rows.length)
			throw new Error(
				"The model connection changed or is no longer available.",
			);
		const session = await client.query(
			"select id,turn_status,parent_session_id,task_state from agent_session where id=$1 and user_id=$2 for update",
			[input.sessionId, input.userId],
		);
		if (
			!session.rows[0] ||
			(session.rows[0].turn_status === "running" &&
				!(
					input.preparedTask &&
					session.rows[0].parent_session_id &&
					session.rows[0].task_state === "working"
				))
		)
			throw new Error(
				"Finish or stop the current turn before sending another prompt.",
			);
		await client.query(
			`insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items)
			 values($1,$2,$3,$4,$5,$6,'queued',$7,$8)`,
			[
				randomUUID(),
				input.sessionId,
				input.userId,
				input.connectionId,
				input.revision,
				input.modelId,
				JSON.stringify(input.messages),
				JSON.stringify(input.items),
			],
		);
		await client.query(
			`update agent_session set harness=$5,listed_model_id=$3,items=$4,turn_status='running',updated_at=now() where id=$1 and user_id=$2`,
			[
				input.sessionId,
				input.userId,
				input.routeId,
				JSON.stringify(input.items),
				subscription ? "codex" : "api",
			],
		);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

/** Resume the actual tool conversation only when transport and model remain compatible. */
export async function previousTurnMessages(
	userId: string,
	sessionId: string,
	modelId: string,
	revision: string,
) {
	const result = await database().query<ApiTurn>(
		"select * from api_turn where user_id=$1 and session_id=$2 order by created_at desc limit 1",
		[userId, sessionId],
	);
	const previous = result.rows[0];
	return previous?.state === "completed" &&
		previous.model_id === modelId &&
		previous.connection_revision === revision
		? previous.messages
		: null;
}

export async function claimApiTurn(): Promise<ApiTurn | null> {
	const result = await database().query<ApiTurn>(
		`update api_turn set state='running',lease_id=$1,heartbeat_at=now(),updated_at=now()
		 where id=(select id from api_turn where state='queued' order by created_at for update skip locked limit 1)
		 returning *`,
		[randomUUID()],
	);
	return result.rows[0] ?? null;
}

export async function renewApiTurn(turn: ApiTurn): Promise<boolean> {
	const result = await database().query(
		`update api_turn set heartbeat_at=now() where id=$1 and lease_id=$2 and state='running' and not cancel_requested returning id`,
		[turn.id, turn.lease_id],
	);
	return Boolean(result.rowCount);
}

export async function checkpointApiTurn(
	turn: ApiTurn,
	messages: ModelMessage[],
	items: readonly SessionItem[],
) {
	const result = await database().query(
		`with saved as (update api_turn set messages=$3,items=$4,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' returning session_id)
		 update agent_session set items=$4,updated_at=now() where id in(select session_id from saved) returning id`,
		[turn.id, turn.lease_id, JSON.stringify(messages), JSON.stringify(items)],
	);
	if (!result.rowCount) throw new Error("API turn lease was lost.");
}

export async function finishApiTurn(
	turn: ApiTurn,
	state: "completed" | "failed" | "cancelled",
	items: readonly SessionItem[],
) {
	const result = await database().query(
		`with saved as (update api_turn set state=$3,items=$4,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' returning session_id)
		 update agent_session set items=$4,turn_status=$5,
		 task_state=case when parent_session_id is null then task_state when $5='completed' then 'done' when $5='failed' then 'failed' else 'idle' end,
		 updated_at=now() where id in(select session_id from saved)`,
		[
			turn.id,
			turn.lease_id,
			state,
			JSON.stringify(items),
			state === "cancelled" ? "idle" : state,
		],
	);
	return Boolean(result.rowCount);
}

export async function cancelApiTurn(userId: string, sessionId: string) {
	await database().query(
		"update api_turn set cancel_requested=true where user_id=$1 and session_id=$2 and state in ('queued','running')",
		[userId, sessionId],
	);
}

/** Never replay a turn whose tool side effects may have happened before worker loss. */
export async function expireApiTurnLeases() {
	await database().query(`with expired as (
	 update api_turn set state='failed',updated_at=now()
	 where state='running' and heartbeat_at < now()-interval '45 seconds'
	 returning session_id,id
	) update agent_session s set turn_status='failed',
	 items=s.items || jsonb_build_array(jsonb_build_object('kind','error','id',e.id::text || ':lost','message','The worker disconnected. Inspect the workspace before continuing; uncertain tool calls were not replayed.')),
	 task_state=case when parent_session_id is null then task_state else 'failed' end,updated_at=now()
	 from expired e where s.id=e.session_id`);
}
