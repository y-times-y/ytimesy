import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { Effect, Schedule } from "effect";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import {
	type ApiTurnSettings,
	apiTurnSettings,
} from "#/domain/api-turn-settings";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import {
	configuredTurnExecutor,
	type TurnExecutor,
} from "#/domain/turn-executor";
import {
	captureTurnFinished,
	captureTurnStarted,
	type TurnAnalyticsSession,
} from "../services/turn-analytics";
import { modelConcurrencyLimits } from "./agent-capacity";
import { dispatchBackgroundJob } from "./background-job-dispatch";
import { wakeConversationProgress } from "./conversation-progress-wake";
import {
	recordConversationPoint,
	recoveredConversation,
} from "./conversation-recovery";
import { database } from "./database";
import { mirrorTurnHistory } from "./turn-history-mirror";

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
	settings?: unknown;
};

/** Internal child starts and wakeups retain the nearest same-model subscription selection. */
export async function inheritedSubscriptionSettings(
	userId: string,
	sessionId: string,
	modelId: string,
) {
	const result = await database().query<{ connection_revision: string }>(
		`with recursive ancestors as (
		 select id,parent_session_id,0 as depth from agent_session where id=$1 and user_id=$2
		 union all select p.id,p.parent_session_id,a.depth+1 from agent_session p
		 join ancestors a on p.id=a.parent_session_id where p.user_id=$2 and a.depth<8
		) select t.connection_revision from ancestors a join api_turn t on t.session_id=a.id
		 where t.user_id=$2 and t.model_id=$3 and t.connection_id is null
		 and t.connection_revision like 'codex-subscription:v1:%'
		 order by a.depth,t.created_at desc limit 1`,
		[sessionId, userId, modelId],
	);
	return result.rows[0]
		? subscriptionTurnSettings(result.rows[0].connection_revision)
		: null;
}

/** Internal child starts and wakeups retain the nearest same-model API-key turn's settings. */
export async function inheritedApiTurnSettings(
	userId: string,
	sessionId: string,
	modelId: string,
	connectionId: string,
) {
	const result = await database().query<{ settings: unknown }>(
		`with recursive ancestors as (
		 select id,parent_session_id,0 as depth from agent_session where id=$1 and user_id=$2
		 union all select p.id,p.parent_session_id,a.depth+1 from agent_session p
		 join ancestors a on p.id=a.parent_session_id where p.user_id=$2 and a.depth<8
		) select t.settings from ancestors a join api_turn t on t.session_id=a.id
		 where t.user_id=$2 and t.model_id=$3 and t.connection_id=$4
		 order by a.depth,t.created_at desc limit 1`,
		[sessionId, userId, modelId, connectionId],
	);
	return apiTurnSettings(result.rows[0]?.settings);
}

/** A child may report waiting before its model loop exits; UI status is not a turn lease. */
export async function hasActiveApiTurn(userId: string, sessionId: string) {
	const result = await database().query<{ active: boolean }>(
		"select exists(select 1 from api_turn where user_id=$1 and session_id=$2 and state in ('queued','running')) as active",
		[userId, sessionId],
	);
	return result.rows[0]?.active ?? false;
}

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
	idempotencyKey?: string;
	settings?: ApiTurnSettings;
}) {
	const client = await database().connect();
	let turnId: string | undefined;
	let started: TurnAnalyticsSession | undefined;
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
			"select id,turn_status,parent_session_id,task_state,task_access from agent_session where id=$1 and user_id=$2 for update",
			[input.sessionId, input.userId],
		);
		if (input.idempotencyKey) {
			const existing = await client.query(
				"select id from api_turn where session_id=$1 and user_id=$2 and idempotency_key=$3",
				[input.sessionId, input.userId, input.idempotencyKey],
			);
			if (existing.rows.length) {
				await client.query("commit");
				return;
			}
		}
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
		await recordConversationPoint(client, input);
		turnId = randomUUID();
		started = {
			userId: input.userId,
			harness: subscription ? "codex" : "api",
			parentSessionId: session.rows[0].parent_session_id ?? null,
			taskAccess: session.rows[0].task_access ?? null,
		};
		await client.query(
			`insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items,idempotency_key,executor,settings)
			 values($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11)`,
			[
				turnId,
				input.sessionId,
				input.userId,
				input.connectionId,
				input.revision,
				input.modelId,
				JSON.stringify(input.messages),
				JSON.stringify(input.items),
				input.idempotencyKey ?? null,
				configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET),
				JSON.stringify(input.settings ?? {}),
			],
		);
		await client.query(
			`update agent_session set harness=$5,listed_model_id=$3,items=$4,turn_status='running',task_state=case when parent_session_id is null then task_state else 'working' end,updated_at=now() where id=$1 and user_id=$2`,
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
	if (turnId && started) void captureTurnStarted(started, turnId, new Date());
	if (
		configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET) ===
		"durable-object"
	) {
		try {
			if (
				!(await dispatchBackgroundJob({
					id: randomUUID(),
					kind: "model-admission",
				}))
			)
				console.warn(
					"Cloudflare turn wake is unavailable; queued turn awaits recovery.",
				);
		} catch {
			console.warn(
				"Cloudflare turn wake deferred; queued turn awaits recovery.",
			);
		}
	}
}

/** Resume the actual tool conversation only when transport and model remain compatible. */
export async function previousTurnMessages(
	userId: string,
	sessionId: string,
	modelId: string,
	revision: string,
) {
	const recovered = await recoveredConversation(
		userId,
		sessionId,
		modelId,
		revision,
	);
	if (recovered !== null) return recovered.messages;
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

/**
 * The chat DO loads its turn's history itself (once per turn), so admission for
 * it returns identities only rather than the whole conversation.
 */
const CLAIM_IDENTITY_COLUMNS =
	"id,session_id,user_id,connection_id,connection_revision,model_id,state,lease_id,settings,'[]'::jsonb as messages,'[]'::jsonb as items";

export async function claimApiTurn(
	perUserLimit = 2,
	fleetLimit = modelConcurrencyLimits().fleet,
	executor: TurnExecutor = "node",
	sessionId?: string,
): Promise<ApiTurn | null> {
	if (
		!Number.isInteger(perUserLimit) ||
		perUserLimit < 1 ||
		perUserLimit > 64 ||
		!Number.isInteger(fleetLimit) ||
		fleetLimit < 1 ||
		fleetLimit > 10_000
	)
		throw new Error("Turn admission limits must be positive bounded integers.");
	const client = await database().connect();
	let discardConnection = false;
	try {
		await client.query("begin");
		// Admission is short and serialized across workers; model/tool work never holds this lock.
		// Poolers may ignore startup settings. Enforce the bounds inside this transaction,
		// including when a worker disappears after claiming a turn but before committing.
		await client.query("set local idle_in_transaction_session_timeout = '30s'");
		await client.query("set local statement_timeout = '20s'");
		const admission = await client.query<{ acquired: boolean }>(
			"select pg_try_advisory_xact_lock(81738419) as acquired",
		);
		if (!admission.rows[0]?.acquired) {
			await client.query("commit");
			return null;
		}
		const result = await client.query<ApiTurn>(
			`update api_turn set state='running',lease_id=$1,heartbeat_at=now(),updated_at=now(),executor=$4
			 where id=(select q.id from api_turn q where q.state='queued' and q.executor=$4 and not q.cancel_requested
			 and ($5::uuid is null or q.session_id=$5::uuid)
			 and (select count(*) from api_turn r where r.user_id=q.user_id and r.state='running')<$2
			 and (select count(*) from api_turn r where r.state='running')<$3
			 order by q.created_at for update skip locked limit 1)
			 returning ${executor === "durable-object" ? CLAIM_IDENTITY_COLUMNS : "*"}`,
			[randomUUID(), perUserLimit, fleetLimit, executor, sessionId ?? null],
		);
		await client.query("commit");
		return result.rows[0] ?? null;
	} catch (error) {
		try {
			await client.query("rollback");
		} catch {
			// Never return an uncertain transaction to the pool, or hide its original failure.
			discardConnection = true;
		}
		throw error;
	} finally {
		client.release(discardConnection);
	}
}

export async function renewApiTurn(turn: ApiTurn): Promise<boolean> {
	// Only the idempotent, identity-fenced heartbeat may retry a disconnected socket.
	// Cancellation, stale leases, pool saturation and SQL errors remain terminal.
	const result = await Effect.runPromise(
		Effect.tryPromise({
			try: () =>
				database().query(
					`update api_turn set heartbeat_at=now() where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and heartbeat_at>=now()-interval '45 seconds' returning id`,
					[turn.id, turn.lease_id],
				),
			catch: (error) => error,
		}).pipe(
			Effect.retry({
				schedule: Schedule.intersect(
					Schedule.recurs(1),
					Schedule.spaced("250 millis"),
				),
				while: (error) =>
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					["ECONNRESET", "EPIPE", "08006"].includes(String(error.code)),
			}),
			Effect.either,
		),
	);
	if (result._tag === "Left") throw result.left;
	return Boolean(result.right.rowCount);
}

export async function checkpointApiTurn(
	turn: ApiTurn,
	messages: ModelMessage[],
	items: readonly SessionItem[],
) {
	const result = await database().query<{ version: string }>(
		`with saved as (update api_turn set messages=$3,items=$4,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and heartbeat_at>=now()-interval '45 seconds' returning session_id,updated_at)
		 update agent_session set items=$4,updated_at=now() where id in(select session_id from saved)
		 returning (select updated_at::text from saved) as version`,
		[turn.id, turn.lease_id, JSON.stringify(messages), JSON.stringify(items)],
	);
	if (!result.rows[0]) throw new Error("API turn lease was lost.");
	mirrorTurnHistory(turn.id, result.rows[0].version, { messages, items });
	await wakeConversationProgress();
}

/** Stream checkpoints avoid rewriting the model history on every text delta. */
export async function publishApiTurnProgress(
	turn: ApiTurn,
	items: readonly SessionItem[],
) {
	const result = await database().query<{ version: string }>(
		`with saved as (update api_turn set items=$3,updated_at=now()
	 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
	 and heartbeat_at>=now()-interval '45 seconds' returning session_id,updated_at)
	 update agent_session set items=$3,updated_at=now() where id in(select session_id from saved)
	 returning (select updated_at::text from saved) as version`,
		[turn.id, turn.lease_id, JSON.stringify(items)],
	);
	if (result.rows[0])
		mirrorTurnHistory(turn.id, result.rows[0].version, { items });
	else {
		const cancelled = await database().query(
			"select 1 from api_turn where id=$1 and lease_id=$2 and user_id=$3 and cancel_requested",
			[turn.id, turn.lease_id, turn.user_id],
		);
		if (cancelled.rows.length) throw new ApiTurnCancelled();
		throw new Error("API turn lease was lost.");
	}
	await wakeConversationProgress();
}

/** Whichever watcher noticed first, a stop the user asked for is a clean stop. */
export async function apiTurnCancelRequested(turn: ApiTurn) {
	const result = await database().query(
		"select 1 from api_turn where id=$1 and lease_id=$2 and user_id=$3 and cancel_requested",
		[turn.id, turn.lease_id, turn.user_id],
	);
	return result.rows.length > 0;
}

export async function finishApiTurn(
	turn: ApiTurn,
	state: "completed" | "failed" | "cancelled",
	items: readonly SessionItem[],
) {
	return (await finalizeApiTurn(turn, state, items)) !== null;
}

/** Return the effective state so a stop racing with completion still stops owned commands. */
export async function finalizeApiTurn(
	turn: ApiTurn,
	state: "completed" | "failed" | "cancelled",
	items: readonly SessionItem[],
) {
	const result = await database().query<
		{ state: "completed" | "failed" | "cancelled" } & SettledTurnRow
	>(
		`with saved as (update api_turn set state=case when cancel_requested then 'cancelled' else $3 end,items=$4,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and heartbeat_at>=now()-interval '45 seconds' returning id,session_id,state,created_at)
		 update agent_session s set items=$4,turn_status=case when saved.state='cancelled' then 'idle' else saved.state end,
		 task_state=case when parent_session_id is null then task_state when saved.state='completed' then 'done' when saved.state='failed' then 'failed' else 'idle' end,
		 updated_at=now() from saved where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS}`,
		[turn.id, turn.lease_id, state, JSON.stringify(items)],
	);
	captureSettledTurns(result.rows);
	if (result.rows[0]) await wakeConversationProgress();
	return result.rows[0]?.state ?? null;
}

export async function cancelApiTurn(userId: string, sessionId: string) {
	const result = await database().query<
		{ id: string; lease_id: string | null } & Partial<SettledTurnRow>
	>(
		`with cancelled as (update api_turn set cancel_requested=true,state=case when state='queued' then 'cancelled' else state end
		 where user_id=$1 and session_id=$2 and state in ('queued','running') returning id,lease_id,session_id,state,created_at),
		 updated as (update agent_session s set turn_status='idle',updated_at=now() from cancelled c where s.id=c.session_id and c.state='cancelled'
		  returning ${SETTLED_TURN_COLUMNS.replaceAll("saved.", "c.")})
		 select c.id,c.lease_id,u.* from cancelled c left join updated u on u.turn_id=c.id`,
		[userId, sessionId],
	);
	// A queued turn settles here; a running one settles when its executor finalizes it.
	captureSettledTurns(
		result.rows.filter((row): row is typeof row & SettledTurnRow =>
			Boolean(row.turn_id),
		),
	);
	return result.rows.map(({ id, lease_id }) => ({ id, lease_id }));
}

/** The settled turn plus the session fields its analytics event is categorized by. */
type SettledTurnRow = {
	turn_id: string;
	state: "completed" | "failed" | "cancelled";
	started_at: Date | string | null;
	user_id: string;
	harness: string;
	parent_session_id: string | null;
	task_access: string | null;
};
const SETTLED_TURN_COLUMNS =
	"saved.id as turn_id,saved.state,saved.created_at as started_at,s.user_id,s.harness,s.parent_session_id,s.task_access";

function captureSettledTurns(rows: readonly SettledTurnRow[]) {
	const endedAt = new Date();
	for (const row of rows)
		void captureTurnFinished(
			{
				userId: row.user_id,
				harness: row.harness,
				parentSessionId: row.parent_session_id,
				taskAccess: row.task_access,
			},
			row.turn_id,
			row.state,
			{
				startedAt: row.started_at ? new Date(row.started_at) : null,
				endedAt,
			},
		);
}

/**
 * Never replay a turn whose tool side effects may have happened before worker loss.
 * Chat Durable Objects resume their own interrupted steps (alarm retries back off
 * for up to about two minutes), so their turns get a longer grace period.
 */
export async function expireApiTurnLeases() {
	const result = await database().query<SettledTurnRow>(`with saved as (
	 update api_turn set state='failed',updated_at=now()
	 where state='running' and heartbeat_at < now()-case when executor='durable-object'
	  then interval '3 minutes' else interval '45 seconds' end
	 returning session_id,id,state,created_at
	) update agent_session s set turn_status='failed',
	 items=s.items || jsonb_build_array(jsonb_build_object('kind','error','id',saved.id::text || ':lost','message','The worker disconnected. Inspect the workspace before continuing; uncertain tool calls were not replayed.')),
	 task_state=case when parent_session_id is null then task_state else 'failed' end,updated_at=now()
	 from saved where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS}`);
	captureSettledTurns(result.rows ?? []);
}
