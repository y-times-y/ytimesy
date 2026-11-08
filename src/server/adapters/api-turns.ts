import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { Effect, Schedule } from "effect";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import {
	type ApiTurnSettings,
	apiTurnSettings,
} from "#/domain/api-turn-settings";
import { isClaudeCodeRevision } from "#/domain/claude-code-route";
import { CONVERSATION_FORK_REQUEST_ID } from "#/domain/conversation-fork";
import { jsonbText } from "#/domain/jsonb";
import {
	type TurnFailover,
	type TurnFailoverColumn,
	turnFailover,
} from "#/domain/model-failover";
import { continuedTurnHistory } from "#/domain/runtime-handoff";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { settledTurnItems } from "#/domain/turn-end";
import {
	configuredTurnExecutor,
	type TurnExecutor,
} from "#/domain/turn-executor";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import { withStepTrace } from "../services/step-timing";
import {
	captureTurnFinished,
	captureTurnStarted,
	type TurnAnalyticsSession,
} from "../services/turn-analytics";
import { startAfterResponse } from "./after-response";
import { modelConcurrencyLimits } from "./agent-capacity";
import { TURN_DEADLINE_REQUEST_ID } from "./attempt-loop-store";
import { dispatchBackgroundJob } from "./background-job-dispatch";
import { wakeConversationProgress } from "./conversation-progress-wake";
import {
	recordConversationPoint,
	recoveredConversation,
} from "./conversation-recovery";
import { database } from "./database";
import { infrastructureAdmissionEnabled } from "./freestyle/usage-admission";
import { assertUsageWindowsOpen } from "./infrastructure-usage";
import { observePeerInbox } from "./peer-inbox-observation";
import { trainingEligibleAtTurnStart } from "./training-consent";
import { mirrorTurnHistory } from "./turn-history-mirror";
import { startQueuedTurnsDirectly } from "./turn-start";

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
	/** The fallback route serving the rest of this turn after a failover (TurnFailover), and its same-route retries. */
	failover?: unknown;
	/** Epoch ms the turn was queued, when its loader read it (timing only). */
	queued_at_ms?: number | null;
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
	/** The user chose to continue this turn on a fallback route from the start. */
	failover?: TurnFailover;
}) {
	// Every turn is new work and waits for an exhausted usage window: one the
	// user (or a wake-up) starts, and a subagent's task too (its parent's own
	// turn still finishes, without starting more work past the limit).
	if (infrastructureAdmissionEnabled())
		await assertUsageWindowsOpen(input.userId);
	const client = await database().connect();
	let turnId: string | undefined;
	let started: TurnAnalyticsSession | undefined;
	try {
		await client.query("begin");
		const subscription = subscriptionTurnSettings(input.revision);
		const claudeCode = isClaudeCodeRevision(input.revision);
		if ((subscription || claudeCode) && input.connectionId !== null)
			throw new Error("Subscription turns cannot use an API connection.");
		// One statement: the connection (or Codex sign-in) is share-locked,
		// the chat row locked for update, and a turn this send already queued
		// looked up, instead of three round trips.
		const gate = await client.query<{
			connected: boolean;
			found: boolean;
			turn_status: string | null;
			parent_session_id: string | null;
			task_state: string | null;
			task_access: string | null;
			existing: boolean;
		}>(
			`with connection as (${
				subscription
					? "select 1 from agent_account where user_id=$2 and provider='codex' and status='connected' and encrypted_codex_auth is not null for share"
					: claudeCode
						? "select 1 from claude_subscription where user_id=$2 and status in ('connected','limited') for share"
						: "select 1 from model_connection where id=$4 and user_id=$2 and revision=$5 for share"
			}),
			 chat as (select id,turn_status,parent_session_id,task_state,task_access from agent_session where id=$1 and user_id=$2 for update)
			 select exists(select 1 from connection) as connected,chat.id is not null as found,
			 chat.turn_status,chat.parent_session_id,chat.task_state,chat.task_access,
			 ($3::text is not null and exists(select 1 from api_turn t where t.session_id=$1 and t.user_id=$2 and t.idempotency_key=$3::text)) as existing
			 from (select 1) one left join chat on true`,
			subscription || claudeCode
				? [input.sessionId, input.userId, input.idempotencyKey ?? null]
				: [
						input.sessionId,
						input.userId,
						input.idempotencyKey ?? null,
						input.connectionId,
						input.revision,
					],
		);
		const checked = gate.rows[0];
		if (!checked?.connected)
			throw new Error(
				"The model connection changed or is no longer available.",
			);
		if (checked.existing) {
			await client.query("commit");
			return;
		}
		if (
			!checked.found ||
			(checked.turn_status === "running" &&
				!(
					input.preparedTask &&
					checked.parent_session_id &&
					checked.task_state === "working"
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
			parentSessionId: checked.parent_session_id ?? null,
			taskAccess: checked.task_access ?? null,
		};
		// The turn and the chat's running state in one statement.
		await client.query(
			`with queued as (insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items,idempotency_key,executor,settings,failover,training_eligible)
			 values($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,${trainingEligibleAtTurnStart("$3", "$2")}))
			 update agent_session set harness=$14,listed_model_id=$13,items=$8,turn_status='running',task_state=case when parent_session_id is null then task_state else 'working' end,updated_at=now() where id=$2 and user_id=$3`,
			[
				turnId,
				input.sessionId,
				input.userId,
				input.connectionId,
				input.revision,
				input.modelId,
				jsonbText(input.messages),
				jsonbText(input.items),
				input.idempotencyKey ?? null,
				configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET),
				JSON.stringify(input.settings ?? {}),
				input.failover ? JSON.stringify(input.failover) : null,
				input.routeId,
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
		// The turn is committed; waking its executor (an admission claim and the
		// chat's startTurn) need not hold the sender's response. A web request
		// sends it after responding; a lost wake is admitted by the next
		// minute's admission sweep, like before.
		const wake = async () => {
			// From the web Worker: claim here and start the chat's loop through
			// the executor binding (turn-start.ts); elsewhere, the admission job.
			try {
				if (await startQueuedTurnsDirectly()) return;
			} catch {
				console.warn("Direct turn start failed; dispatching admission.");
			}
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
		};
		const traced = () =>
			withStepTrace({ wake: input.sessionId.slice(0, 8) }, wake);
		if (!startAfterResponse(traced)) {
			await traced();
			return;
		}
		// The chat's progress stream shows the sent message and the running
		// turn now, not when the executor's first step relays it (2-4 s later).
		// A failed relay keeps its durable receipt for the step to deliver.
		startAfterResponse(() => relayConversationDeliveriesOnce(input.sessionId));
	}
}

/**
 * The structured history the next turn continues from: the restored point,
 * else the latest settled turn's saved messages however it ended. Null only
 * when nothing was saved (the caller rebuilds visible text instead).
 */
export async function previousTurnMessages(
	userId: string,
	sessionId: string,
	modelId: string,
	revision: string,
) {
	const next = { modelId, connectionRevision: revision };
	// Both reads at once; the latest turn is used only without a restored point.
	const [recovered, result] = await Promise.all([
		recoveredConversation(userId, sessionId),
		database().query<ApiTurn>(
			"select * from api_turn where user_id=$1 and session_id=$2 order by created_at desc limit 1",
			[userId, sessionId],
		),
	]);
	if (recovered !== null)
		return continuedTurnHistory(
			{
				messages: recovered.messages,
				modelId: recovered.modelId,
				connectionRevision: recovered.revision,
				state: "completed",
				failedOver: false,
			},
			next,
		);
	const previous = result.rows[0];
	if (
		!previous ||
		previous.state === "queued" ||
		previous.state === "running" ||
		!Array.isArray(previous.messages) ||
		!previous.messages.length
	)
		return null;
	return continuedTurnHistory(
		{
			messages: previous.messages,
			modelId: previous.model_id,
			connectionRevision: previous.connection_revision,
			state: previous.state,
			// Its native items (encrypted reasoning, signatures) came from the fallback.
			failedOver: turnFailover(previous.failover) !== null,
		},
		next,
	);
}

/**
 * The chat DO loads its turn's history itself (once per turn), so admission for
 * it returns identities only rather than the whole conversation.
 */
const CLAIM_IDENTITY_COLUMNS =
	"id,session_id,user_id,connection_id,connection_revision,model_id,state,lease_id,settings,failover,'[]'::jsonb as messages,'[]'::jsonb as items";

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
	if (executor !== "node" && executor !== "durable-object")
		throw new Error("Unknown turn executor.");
	if (sessionId !== undefined && !UUID.test(sessionId))
		throw new Error("Invalid chat id.");
	const lease = randomUUID();
	// One round trip: the whole transaction goes as one simple-protocol batch,
	// so its values are validated literals above (no parameters). Poolers may
	// ignore startup settings, so the bounds are set inside the transaction,
	// covering a worker that disappears after claiming but before committing.
	// The admission lock (serialized across workers; model/tool work never
	// holds it) is taken first and held until the commit; without it the
	// queued turn is never read or locked, so another worker's claim order
	// is unchanged.
	// A forked chat's turn waits queued until its VM copy is bound
	// (conversation-fork.ts journal).
	const batch = `begin;
set local idle_in_transaction_session_timeout = '30s';
set local statement_timeout = '20s';
with admission as (select pg_try_advisory_xact_lock(81738419) as acquired)
 update api_turn set state='running',lease_id='${lease}',heartbeat_at=now(),updated_at=now(),executor='${executor}'
 where id=(select q.id from api_turn q where (select acquired from admission)
 and q.state='queued' and q.executor='${executor}' and not q.cancel_requested
 ${sessionId ? `and q.session_id='${sessionId}'::uuid` : ""}
 and not exists(select 1 from agent_task_command_receipt f where f.parent_session_id=q.session_id and f.request_id='${CONVERSATION_FORK_REQUEST_ID}')
 and (select count(*) from api_turn r where r.user_id=q.user_id and r.state='running')<${perUserLimit}
 and (select count(*) from api_turn r where r.state='running')<${fleetLimit}
 order by q.created_at for update skip locked limit 1)
 returning ${executor === "durable-object" ? CLAIM_IDENTITY_COLUMNS : "*"};
commit;`;
	const client = await database().connect();
	let discardConnection = false;
	try {
		type Result = { fields?: readonly unknown[]; rows: ApiTurn[] };
		const results = (await client.query(batch)) as unknown as Result[] | Result;
		// The only statement with a result shape is the claim (its returning).
		const claimed = (Array.isArray(results) ? results : [results]).find(
			(result) => result.fields?.length,
		);
		return claimed?.rows[0] ?? null;
	} catch (error) {
		// A failed statement leaves the batch's transaction aborted on this
		// connection; it is rolled back, or the connection is discarded.
		try {
			await client.query("rollback");
		} catch {
			discardConnection = true;
		}
		throw error;
	} finally {
		client.release(discardConnection);
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQL: the turn aliased `alias` has passed its eval runner's hard deadline
 * (saveTurnDeadline). Past it the turn is cancelled on the edge as if its
 * owner pressed Stop, so a detached run ends on time without its runner.
 */
export const turnPastDeadlineSql = (alias: string) =>
	`exists(select 1 from agent_task_command_receipt d where d.parent_session_id=${alias}.session_id
	 and d.request_id='${TURN_DEADLINE_REQUEST_ID}' and d.status='done'
	 and (d.response->>'deadlineAt')::double precision <= extract(epoch from now())*1000)`;

export async function renewApiTurn(turn: ApiTurn): Promise<boolean> {
	// Only the idempotent, identity-fenced heartbeat may retry a disconnected socket.
	// Cancellation, stale leases, pool saturation and SQL errors remain terminal.
	// A turn past its runner deadline is cancelled in the same statement, so
	// the heartbeat fails and the turn settles as a clean stop.
	const result = await Effect.runPromise(
		Effect.tryPromise({
			try: async () => {
				const startedAt = Date.now();
				// The inbox flag rides the heartbeat so steps can skip reading an empty inbox.
				const renewed = await database().query<{ inbox_pending: boolean }>(
					`with expired as (update api_turn t set cancel_requested=true where t.id=$1 and t.lease_id=$2 and t.state='running'
		 and not t.cancel_requested and ${turnPastDeadlineSql("t")} returning t.id)
		 update api_turn set heartbeat_at=now() where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and heartbeat_at>=now()-interval '45 seconds' and not exists(select 1 from expired)
		 returning id,exists(select 1 from agent_peer_inbox q where q.recipient_id=api_turn.session_id and not q.accepted) as inbox_pending`,
					[turn.id, turn.lease_id],
				);
				const row = renewed.rows?.[0];
				if (row && turn.session_id)
					observePeerInbox(turn.session_id, startedAt, row.inbox_pending);
				return renewed;
			},
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

/** `failover`, when given, moves the rest of the turn to its route (or records its same-route retries) in the same write. */
export async function checkpointApiTurn(
	turn: ApiTurn,
	messages: ModelMessage[],
	items: readonly SessionItem[],
	failover?: TurnFailoverColumn,
) {
	const result = await database().query<{ version: string }>(
		`with saved as (update api_turn set messages=$3,items=$4,failover=coalesce($5::jsonb,failover),updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and heartbeat_at>=now()-interval '45 seconds' returning session_id,updated_at)
		 update agent_session set items=$4,updated_at=now() where id in(select session_id from saved)
		 returning (select updated_at::text from saved) as version`,
		[
			turn.id,
			turn.lease_id,
			jsonbText(messages),
			jsonbText(items),
			failover ? JSON.stringify(failover) : null,
		],
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
	const text = jsonbText(items);
	const result = await database().query<{ version: string }>(
		`with saved as (update api_turn set items=$3,updated_at=now()
	 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
	 and heartbeat_at>=now()-interval '45 seconds' returning session_id,updated_at)
	 update agent_session set items=$3,updated_at=now() where id in(select session_id from saved)
	 returning (select updated_at::text from saved) as version`,
		[turn.id, turn.lease_id, text],
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
	return text.length;
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

/**
 * Return the effective state so a stop racing with completion still stops owned commands.
 * `messages`, when given, replaces the saved model history in the same fenced
 * write: a stop or failure mid-step keeps the step's started tool calls, which
 * checkpoints (refused once a stop is requested) could not save.
 */
export async function finalizeApiTurn(
	turn: ApiTurn,
	state: "completed" | "failed" | "cancelled",
	settled: readonly SessionItem[],
	messages?: readonly ModelMessage[],
) {
	// Its messages record when it ended (turn-end.ts).
	const items = settledTurnItems(settled, Date.now());
	const result = await database().query<
		{ state: "completed" | "failed" | "cancelled" } & SettledTurnRow
	>(
		`with saved as (update api_turn set state=case when cancel_requested then 'cancelled' else $3 end,items=$4,messages=coalesce($5::jsonb,messages),updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and heartbeat_at>=now()-interval '45 seconds' returning id,session_id,state,created_at)
		 update agent_session s set items=$4,turn_status=case when saved.state='cancelled' then 'idle' else saved.state end,
		 task_state=case when parent_session_id is null then task_state when saved.state='completed' then 'done' when saved.state='failed' then 'failed' else 'idle' end,
		 updated_at=now() from saved where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS}`,
		[
			turn.id,
			turn.lease_id,
			state,
			jsonbText(items),
			messages ? jsonbText(messages) : null,
		],
	);
	captureSettledTurns(result.rows);
	if (result.rows[0]) await wakeConversationProgress();
	return result.rows[0]?.state ?? null;
}

/** `items` with the element whose id is $2 replaced by $3 (removed when $3 is null). */
const REPLACED_ITEM = `(select coalesce(jsonb_agg(case when e->>'id'=$2 then $3::jsonb else e end order by o)
 filter (where e->>'id'<>$2 or $3::jsonb is not null),'[]'::jsonb) from jsonb_array_elements(items) with ordinality x(e,o))`;
const HAS_ITEM =
	"jsonb_typeof(items)='array' and items @> jsonb_build_array(jsonb_build_object('id',$2::text))";

/**
 * Replaces one item of a turn already marked done (with null, removes it):
 * in the turn's row, the chat, and any turn of the chat queued or started
 * since, which copied the chat's items. Element by element, so a message
 * sent meanwhile stays. The chat's open progress stream gets the change.
 * False when the chat no longer holds the item.
 */
export async function replaceSettledTurnItem(
	turn: Pick<ApiTurn, "id" | "session_id" | "user_id">,
	itemId: string,
	item: SessionItem | null,
) {
	const result = await database().query<{ id: string }>(
		`with turns as (update api_turn set items=${REPLACED_ITEM},updated_at=now()
		 where session_id=$4 and user_id=$5 and (id=$1 or state in ('queued','running')) and ${HAS_ITEM} returning id)
		 update agent_session set items=${REPLACED_ITEM},updated_at=now()
		 where id=$4 and user_id=$5 and ${HAS_ITEM} returning id`,
		[
			turn.id,
			itemId,
			item ? jsonbText(item) : null,
			turn.session_id,
			turn.user_id,
		],
	);
	if (!result.rows[0]) return false;
	await wakeConversationProgress();
	return true;
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

/**
 * A chat Durable Object holds a claimed turn while its previous turn's loop
 * ends. Nothing else renews that turn meanwhile, so the chat keeps it fresh
 * until it starts; otherwise its first step finds the lease stale and drops it.
 */
export async function refreshWaitingApiTurns(
	turns: readonly { turnId: string; leaseId: string }[],
) {
	if (!turns.length) return;
	await database().query(
		`update api_turn t set heartbeat_at=now() from unnest($1::uuid[],$2::uuid[]) w(id,lease_id)
		 where t.id=w.id and t.lease_id=w.lease_id and t.state='running' and t.executor='durable-object'`,
		[turns.map((turn) => turn.turnId), turns.map((turn) => turn.leaseId)],
	);
}

/**
 * Stop on a turn still waiting in its chat's queue: it never ran, so it settles
 * here. The chat reads idle only once no other turn of it is still running:
 * the active turn Stop also cancelled reports its own end when it finishes.
 */
/**
 * Puts a claimed durable turn whose hand-off to its chat failed back in the
 * queue, so the next admission claims it again (with a new lease) instead of
 * it waiting out its lease. Fenced by the lease it was claimed with: a chat
 * that did receive it can no longer read or write it under that lease, so
 * it still runs exactly once.
 */
export async function releaseClaimedApiTurn(turnId: string, leaseId: string) {
	const result = await database().query(
		`update api_turn set state='queued',lease_id=null,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and executor='durable-object'`,
		[turnId, leaseId],
	);
	return (result.rowCount ?? 0) > 0;
}

export async function cancelWaitingApiTurn(turnId: string, leaseId: string) {
	const result = await database().query<SettledTurnRow>(
		`with saved as (update api_turn set state='cancelled',updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and cancel_requested and executor='durable-object'
		 returning id,session_id,state,created_at),
		 busy as (select exists (select 1 from api_turn o join saved on o.session_id=saved.session_id
		  where o.id<>saved.id and o.state in ('queued','running')) as running)
		 update agent_session s set
		 turn_status=case when busy.running then s.turn_status else 'idle' end,
		 task_state=case when parent_session_id is null or busy.running then task_state else 'idle' end,
		 updated_at=now() from saved, busy where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS}`,
		[turnId, leaseId],
	);
	captureSettledTurns(result.rows);
	if (result.rows[0]) await wakeConversationProgress();
	return result.rows.length > 0;
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
	/** How many turns were abandoned, for the owner's alert. */
	return result.rows?.length ?? 0;
}
