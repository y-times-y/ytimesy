import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { Effect, Schedule } from "effect";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import {
	type ApiTurnSettings,
	apiTurnSettings,
} from "#/domain/api-turn-settings";
import {
	CLAUDE_CODE_REVISION_PREFIX,
	isClaudeCodeRevision,
} from "#/domain/claude-code-route";
import { CLAUDE_TURN_LEASE_SECONDS } from "#/domain/claude-parked-turn";
import { CONVERSATION_FORK_REQUEST_ID } from "#/domain/conversation-fork";
import { jsonbText } from "#/domain/jsonb";
import {
	type TurnFailover,
	type TurnFailoverColumn,
	turnFailover,
} from "#/domain/model-failover";
import { continuedTurnHistory, sameTransport } from "#/domain/runtime-handoff";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { settledTurnItems } from "#/domain/turn-end";
import {
	boxTurnUsers,
	chooseTurnExecutor,
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
	storePointMessages,
	turnMessagesObject,
} from "./conversation-recovery";
import { database } from "./database";
import {
	isDroppedConnection,
	retryDroppedConnection,
} from "./dropped-connection-retry";
import { infrastructureAdmissionEnabled } from "./freestyle/usage-admission";
import { assertUsageWindowsOpen } from "./infrastructure-usage";
import { observePeerInbox } from "./peer-inbox-observation";
import { trainingEligibleAtTurnStart } from "./training-consent";
import { mirrorTurnHistory } from "./turn-history-mirror";
import {
	newTurnItemsColumn,
	planItemsWrite,
	rebaseAfterWrite,
} from "./turn-items-storage";
import { turnRunnerBoxAlive } from "./turn-runner-boxes";
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
	/** Set when the turn row is in the new shape: the id of the turn's first item (turn-items-storage.ts). */
	items_from?: string;
	lease_id: string | null;
	settings?: unknown;
	/** The fallback route serving the rest of this turn after a failover (TurnFailover), and its same-route retries. */
	failover?: unknown;
	/** Epoch ms the turn was queued, when its loader read it (timing only). */
	queued_at_ms?: number | null;
	/** How many times a box lost this turn and another took it over. */
	run_attempts?: number;
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

/**
 * Whether a running turn other than `turnId` works on this VM: its chat's
 * own machine, or, for a helper that shares its parent's machine (a reader,
 * or a writer placed 'shared': sharesParentMachine in subagent.ts), its
 * parent's, up the chain. Such a turn may exec at any moment from another
 * isolate, so the VM must not be paused under it.
 */
export async function otherRunningTurnOnMachine(
	userId: string,
	turnId: string,
	vm: string,
) {
	const result = await database().query<{ shared: boolean }>(
		`with recursive machine as (
			select s.provider_ref, s.parent_session_id,
				(s.agent_role is not null and (s.agent_role<>'writer' or s.task_placement='shared')) as shares,
				0 as depth
			from api_turn t join agent_session s on s.id=t.session_id
			where t.user_id=$1 and t.state='running' and t.id<>$2::uuid
			union all
			select parent.provider_ref, parent.parent_session_id,
				(parent.agent_role is not null and (parent.agent_role<>'writer' or parent.task_placement='shared')),
				machine.depth + 1
			from machine join agent_session parent on parent.id=machine.parent_session_id
			where machine.shares and parent.user_id=$1 and machine.depth < 8
		)
		select exists(select 1 from machine where provider_ref=$3) as shared`,
		[userId, turnId, vm],
	);
	return result.rows[0]?.shared ?? true;
}

export async function enqueueApiTurn(input: {
	sessionId: string;
	userId: string;
	connectionId: string | null;
	revision: string;
	modelId: string;
	routeId: string;
	messages: ModelMessage[];
	/** The chat's whole transcript after this send (replaces the stored one). */
	items: readonly SessionItem[];
	/**
	 * Instead: the items this send adds, appended in the database, so the
	 * send never reads the transcript (megabytes) nor overwrites a write
	 * that landed after it read.
	 */
	appendItems?: readonly SessionItem[];
	preparedTask?: boolean;
	idempotencyKey?: string;
	settings?: ApiTurnSettings;
	/** The user chose to continue this turn on a fallback route from the start. */
	failover?: TurnFailover;
	/**
	 * The settled turn this one continues unchanged (previousTurnHistory):
	 * `messages` are then only what follows its history, and the database
	 * prepends that history itself, so the send never reads it.
	 */
	base?: TurnBase;
}) {
	// Every turn is new work and waits for an exhausted usage window: one the
	// user (or a wake-up) starts, and a subagent's task too (its parent's own
	// turn still finishes, without starting more work past the limit).
	if (infrastructureAdmissionEnabled())
		await assertUsageWindowsOpen(input.userId);
	// The recovery point's messages go to private storage first, so neither
	// its row (megabytes per message otherwise) nor the chat's lock waits on it.
	const sentMessage = [...(input.appendItems ?? input.items)]
		.reverse()
		.find((item) => item.kind === "userMessage");
	// Continuing a settled turn, the point's messages are that turn's final
	// history, which its executor stored when it ended (turnMessagesObject).
	const messagesObject =
		input.messages.at(-1)?.role !== "user"
			? null
			: input.base
				? turnMessagesObject(input.userId, input.sessionId, input.base)
				: await storePointMessages({
						userId: input.userId,
						sessionId: input.sessionId,
						messageId: sentMessage?.id,
						messages: input.messages,
					});
	// Where the turn runs: its chat's Durable Object, or a turn runner box
	// (turn-executor.ts chooseTurnExecutor), decided before the chat is locked.
	const configuredExecutor = configuredTurnExecutor(
		process.env.YTIMESY_MODEL_EXECUTION_TARGET,
	);
	const boxUsers = boxTurnUsers(process.env.YTIMESY_BOX_TURN_USERS);
	const eligibleForBox =
		!subscriptionTurnSettings(input.revision) &&
		!isClaudeCodeRevision(input.revision);
	const chosenExecutor = chooseTurnExecutor({
		configured: configuredExecutor,
		userId: input.userId,
		boxUsers,
		eligible: eligibleForBox,
		boxAlive:
			boxUsers.size > 0 && eligibleForBox
				? await turnRunnerBoxAlive().catch(() => false)
				: false,
	});
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
		if (input.base) {
			// The history it continues, unchanged since it was planned (share-locked
			// until commit); otherwise the caller plans the send again.
			const base = await client.query<{ count: number }>(
				`select jsonb_array_length(messages) as count from api_turn
				 where id=$1 and session_id=$2 and user_id=$3 and updated_at::text=$4 for share`,
				[input.base.turnId, input.sessionId, input.userId, input.base.version],
			);
			if (base.rows[0]?.count !== input.base.count) throw new TurnBaseChanged();
		}
		await recordConversationPoint(client, {
			...input,
			messagesObject,
			messagesUnknown: Boolean(input.base),
		});
		turnId = randomUUID();
		const executor = chosenExecutor;
		started = {
			userId: input.userId,
			harness: subscription ? "codex" : "api",
			parentSessionId: checked.parent_session_id ?? null,
			taskAccess: checked.task_access ?? null,
		};
		// The turn and the chat's running state in one statement.
		const append = input.appendItems !== undefined;
		const written = append ? (input.appendItems ?? []) : input.items;
		// Appending: the stored transcript plus this send's items (the row is
		// locked above); a turn row keeping whole items gets the same.
		const whole = append
			? "coalesce((select a.items from agent_session a where a.id=$2),'[]'::jsonb)||$8::jsonb"
			: "$8";
		// Continuing a turn: its history (copied inside the database) and then
		// this send's messages.
		const messages = input.base
			? "(select b.messages from api_turn b where b.id=$16::uuid)||$7::jsonb"
			: "$7";
		await client.query(
			`with queued as (insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items,idempotency_key,executor,settings,failover,training_eligible,base_turn_id,base_version,base_count)
			 values($1,$2,$3,$4,$5,$6,'queued',${messages},coalesce($15::jsonb,${whole}),$9,$10,$11,$12,${trainingEligibleAtTurnStart("$3", "$2")},$16::uuid,$17::text,$18::int))
			 update agent_session set harness=$14,listed_model_id=$13,items=${append ? "coalesce(items,'[]'::jsonb)||$8::jsonb" : "$8"},turn_status='running',task_state=case when parent_session_id is null then task_state else 'working' end,updated_at=now() where id=$2 and user_id=$3`,
			[
				turnId,
				input.sessionId,
				input.userId,
				input.connectionId,
				input.revision,
				input.modelId,
				jsonbText(input.messages),
				jsonbText(written),
				input.idempotencyKey ?? null,
				executor,
				JSON.stringify(input.settings ?? {}),
				input.failover ? JSON.stringify(input.failover) : null,
				input.routeId,
				subscription ? "codex" : "api",
				executor === "durable-object" ? newTurnItemsColumn(written) : null,
				input.base?.turnId ?? null,
				input.base?.version ?? null,
				input.base?.count ?? null,
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
	if (chosenExecutor === "durable-object") {
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

/** The history changed between planning a send on it and queueing the send. */
export class TurnBaseChanged extends Error {
	constructor() {
		super("The conversation changed while this message was being sent.");
	}
}

/**
 * A settled turn whose saved history the next turn continues unchanged (the
 * same model and credentials, every tool call answered): its row version,
 * message count and size (JSON characters).
 */
export type TurnBase = {
	readonly turnId: string;
	readonly version: string;
	readonly count: number;
	readonly bytes: number;
};

/**
 * Whether a jsonb array of model messages has an assistant tool call (not
 * provider-executed) without a tool result: closeUnansweredToolCalls would
 * change it.
 */
const UNANSWERED_TOOL_CALL_SQL = (column: string) => `exists(
 (select p->>'toolCallId' from jsonb_array_elements(${column}) m,
   jsonb_array_elements(case when jsonb_typeof(m->'content')='array' then m->'content' else '[]'::jsonb end) p
  where m->>'role'='assistant' and p->>'type'='tool-call' and coalesce(p->>'providerExecuted','false')<>'true')
 except
 (select q->>'toolCallId' from jsonb_array_elements(${column}) r,
   jsonb_array_elements(case when jsonb_typeof(r->'content')='array' then r->'content' else '[]'::jsonb end) q
  where r->>'role'='tool' and q->>'type'='tool-result'))`;

/**
 * What the next turn continues from, as previousTurnMessages decides it,
 * without reading the history when it continues unchanged: then only the
 * settled turn's identity (`base`), and the database copies its history
 * into the new turn (enqueueApiTurn). Otherwise the history itself.
 */
export async function previousTurnHistory(
	userId: string,
	sessionId: string,
	modelId: string,
	revision: string,
): Promise<
	| { readonly base: TurnBase; readonly messages?: undefined }
	| { readonly messages: ModelMessage[]; readonly base?: undefined }
	| null
> {
	const [recovered, result] = await Promise.all([
		recoveredConversation(userId, sessionId),
		database().query<{
			id: string;
			state: ApiTurn["state"];
			model_id: string;
			connection_revision: string;
			failover: unknown;
			version: string;
			count: number;
			bytes: number;
			unanswered: boolean;
		}>(
			`select id,state,model_id,connection_revision,failover,updated_at::text as version,
			 case when jsonb_typeof(messages)='array' then jsonb_array_length(messages) else 0 end as count,
			 length(messages::text) as bytes,
			 case when jsonb_typeof(messages)='array' then ${UNANSWERED_TOOL_CALL_SQL("messages")} else true end as unanswered
			 from api_turn where user_id=$1 and session_id=$2 order by created_at desc limit 1`,
			[userId, sessionId],
		),
	]);
	const previous = result.rows[0];
	if (
		recovered === null &&
		previous &&
		previous.state !== "queued" &&
		previous.state !== "running" &&
		previous.count > 0 &&
		!previous.unanswered &&
		sameTransport(
			{
				modelId: previous.model_id,
				connectionRevision: previous.connection_revision,
				failedOver: turnFailover(previous.failover) !== null,
			},
			{ modelId, connectionRevision: revision },
		)
	)
		return {
			base: {
				turnId: previous.id,
				version: previous.version,
				count: previous.count,
				bytes: Number(previous.bytes),
			},
		};
	if (recovered !== null)
		return {
			messages: continuedTurnHistory(
				{
					messages: recovered.messages,
					modelId: recovered.modelId,
					connectionRevision: recovered.revision,
					state: "completed",
					failedOver: false,
				},
				{ modelId, connectionRevision: revision },
			),
		};
	const messages = await previousTurnMessages(
		userId,
		sessionId,
		modelId,
		revision,
	);
	return messages ? { messages } : null;
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
		database().query<
			Pick<
				ApiTurn,
				"messages" | "model_id" | "connection_revision" | "state" | "failover"
			>
		>(
			"select messages,model_id,connection_revision,state,failover from api_turn where user_id=$1 and session_id=$2 order by created_at desc limit 1",
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

/**
 * SQL: the turn's lease is fresh, renewed within its window. A chat
 * object's Claude Code turn may park between steps and renew only every
 * CLAUDE_PARKED_RENEW_MS (claude-parked-turn.ts), so its window is
 * CLAUDE_TURN_LEASE_SECONDS, still inside the three minutes after which
 * expireApiTurnLeases fails it; every other turn's (box turns, API and
 * Codex turns) stays 45 seconds. `alias` names the turn row where the
 * statement aliases it.
 */
export function apiTurnLeaseFreshSql(alias?: string) {
	const c = alias ? `${alias}.` : "";
	return `${c}heartbeat_at>=now()-case when ${c}executor='durable-object' and ${c}connection_id is null
	 and starts_with(${c}connection_revision,'${CLAUDE_CODE_REVISION_PREFIX}')
	 then interval '${CLAUDE_TURN_LEASE_SECONDS} seconds' else interval '45 seconds' end`;
}

/**
 * Renews the turn's lease ($1 id, $2 lease) unless it is cancelled or stale;
 * a turn past its runner deadline is cancelled in the same statement, so
 * the renewal fails and the turn settles as a clean stop. Returns the row
 * with whether the chat's peer inbox holds anything (and a sent message).
 */
const RENEW_TURN_LEASE_SQL = `with expired as (update api_turn t set cancel_requested=true where t.id=$1 and t.lease_id=$2 and t.state='running'
		 and not t.cancel_requested and ${turnPastDeadlineSql("t")} returning t.id)
		 update api_turn set heartbeat_at=now() where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and ${apiTurnLeaseFreshSql()} and not exists(select 1 from expired)
		 returning id,session_id,exists(select 1 from agent_peer_inbox q where q.recipient_id=api_turn.session_id and not q.accepted) as inbox_pending,
		 exists(select 1 from agent_peer_inbox q where q.recipient_id=api_turn.session_id and not q.accepted and q.queued_send->>'released'='true') as sent_pending`;
type RenewedTurnLease = {
	session_id: string;
	inbox_pending: boolean;
	sent_pending: boolean;
};

/**
 * The renewal of a parked Claude Code turn, which runs no step
 * (claude-parked-turn.ts): "renewed", "inbox" when renewed but the chat's
 * peer inbox holds something a step should see, or "lost" (cancelled, past
 * its deadline, stale or no longer this lease's), when a step should run
 * and settle it.
 */
export async function renewParkedClaudeTurn(
	turnId: string,
	leaseId: string,
): Promise<"renewed" | "inbox" | "lost"> {
	const startedAt = Date.now();
	const row = (
		await retryDroppedConnection(() =>
			database().query<RenewedTurnLease>(RENEW_TURN_LEASE_SQL, [
				turnId,
				leaseId,
			]),
		)
	).rows?.[0];
	if (!row) return "lost";
	observePeerInbox(
		row.session_id,
		startedAt,
		row.inbox_pending,
		row.sent_pending,
	);
	return row.inbox_pending || row.sent_pending ? "inbox" : "renewed";
}

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
				const renewed = await database().query<RenewedTurnLease>(
					RENEW_TURN_LEASE_SQL,
					[turn.id, turn.lease_id],
				);
				const row = renewed.rows?.[0];
				if (row && turn.session_id)
					observePeerInbox(
						turn.session_id,
						startedAt,
						row.inbox_pending,
						row.sent_pending,
					);
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
					(isDroppedConnection(error) ||
						("code" in error &&
							["ECONNRESET", "EPIPE", "08006"].includes(String(error.code)))),
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
	// $5 is the failover, so the first item's id is $6.
	const write = planItemsWrite(turn, items, 4, "agent_session.items", 6);
	const result = await retryDroppedConnection(() =>
		database().query<{ version: string; previous: string; items_rev: string }>(
			`with saved as (update api_turn set messages=$3,base_turn_id=null,base_version=null,base_count=null,items=${write.apiTurn},failover=coalesce($5::jsonb,failover),updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
		 and ${apiTurnLeaseFreshSql()} returning session_id,updated_at)
		 update agent_session set items=${write.session},updated_at=now() where id in(select session_id from saved)
		 returning (select updated_at::text from saved) as version,${PREVIOUS_VERSION},items_rev::text as items_rev`,
			[
				turn.id,
				turn.lease_id,
				jsonbText(messages),
				write.itemsText,
				failover ? JSON.stringify(failover) : null,
				...write.extra,
			],
		),
	);
	if (!result.rows[0]) throw new Error("API turn lease was lost.");
	rebaseAfterWrite(turn, items, write);
	mirrorTurnHistory(
		turn.id,
		result.rows[0].version,
		{ messages, items },
		result.rows[0].previous,
		result.rows[0].items_rev,
	);
	await wakeConversationProgress();
}

/**
 * The turn row's version just before the write (the statement's snapshot
 * does not see its own update): the local history copy may move to the new
 * version only from this one, so a write by anyone else in between is not
 * folded into it unseen.
 */
const PREVIOUS_VERSION =
	"(select updated_at::text from api_turn where id=$1) as previous";

/** Stream checkpoints avoid rewriting the model history on every text delta. */
export async function publishApiTurnProgress(
	turn: ApiTurn,
	items: readonly SessionItem[],
) {
	const write = planItemsWrite(turn, items, 3, "agent_session.items");
	const result = await retryDroppedConnection(() =>
		database().query<{ version: string; previous: string; items_rev: string }>(
			`with saved as (update api_turn set items=${write.apiTurn},updated_at=now()
	 where id=$1 and lease_id=$2 and state='running' and not cancel_requested
	 and ${apiTurnLeaseFreshSql()} returning session_id,updated_at)
	 update agent_session set items=${write.session},updated_at=now() where id in(select session_id from saved)
	 returning (select updated_at::text from saved) as version,${PREVIOUS_VERSION},items_rev::text as items_rev`,
			[turn.id, turn.lease_id, write.itemsText, ...write.extra],
		),
	);
	if (result.rows[0]) {
		rebaseAfterWrite(turn, items, write);
		mirrorTurnHistory(
			turn.id,
			result.rows[0].version,
			{ items },
			result.rows[0].previous,
			result.rows[0].items_rev,
		);
	} else {
		const cancelled = await database().query(
			"select 1 from api_turn where id=$1 and lease_id=$2 and user_id=$3 and cancel_requested",
			[turn.id, turn.lease_id, turn.user_id],
		);
		if (cancelled.rows.length) throw new ApiTurnCancelled();
		throw new Error("API turn lease was lost.");
	}
	await wakeConversationProgress();
	return write.bytes;
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
	// $5 is the messages, so the first item's id is $6.
	const write = planItemsWrite(turn, items, 4, "s.items", 6);
	const result = await database().query<
		{ state: "completed" | "failed" | "cancelled" } & SettledTurnRow & {
				version: string;
				previous: string;
				items_rev: string;
			}
	>(
		`with saved as (update api_turn set state=case when cancel_requested then 'cancelled' else $3 end,items=${write.apiTurn},messages=coalesce($5::jsonb,messages),
		 base_turn_id=case when $5::jsonb is null then base_turn_id end,updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and ${apiTurnLeaseFreshSql()} returning id,session_id,state,created_at,updated_at)
		 update agent_session s set items=${write.session},turn_status=case when saved.state='cancelled' then 'idle' else saved.state end,
		 task_state=case when parent_session_id is null then task_state when saved.state='completed' then 'done' when saved.state='failed' then 'failed' else 'idle' end,
		 updated_at=now() from saved where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS},
		 saved.updated_at::text as version,${PREVIOUS_VERSION},s.items_rev::text as items_rev`,
		[
			turn.id,
			turn.lease_id,
			state,
			write.itemsText,
			messages ? jsonbText(messages) : null,
			...write.extra,
		],
	);
	captureSettledTurns(result.rows);
	const settledRow = result.rows[0];
	if (settledRow) {
		// The chat's copy follows the last write too: the next turn continues
		// from exactly this history (previousTurnHistory) and reads only what
		// follows it when the copy is this version.
		mirrorTurnHistory(
			turn.id,
			settledRow.version,
			messages ? { messages: [...messages], items } : { items },
			settledRow.previous,
			settledRow.items_rev,
			true,
		);
		await wakeConversationProgress();
	}
	return settledRow?.state ?? null;
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
		`with turns as (update api_turn set items=case when jsonb_typeof(items)='array' then ${REPLACED_ITEM} else items end,updated_at=now()
		 where session_id=$4 and user_id=$5 and (id=$1 or state in ('queued','running')) and (${HAS_ITEM} or (jsonb_typeof(items)='object' and state in ('queued','running'))) returning id)
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
/** Shown when a chat's own executor gives up on a step that kept being cut off. */
export const ABANDONED_TURN_MESSAGE =
	"This step kept being interrupted by the platform, so the turn was stopped. Inspect the workspace before continuing; uncertain tool calls were not replayed.";

/**
 * Fails the turn the executor has just stopped driving, now. Waiting for its
 * lease to lapse left the chat "running" for three minutes with a generic
 * message. Fenced by the lease, so only the attempt that owns the turn (or a
 * settled one, a no-op) can do it. Returns whether a running turn was failed.
 */
export async function abandonApiTurn(turnId: string, leaseId: string) {
	const result = await database().query<SettledTurnRow>(
		`with saved as (
	 update api_turn set state='failed',updated_at=now()
	 where id=$1 and lease_id=$2 and state='running'
	 returning session_id,id,state,created_at
	) update agent_session s set turn_status='failed',
	 items=s.items || jsonb_build_array(jsonb_build_object('kind','error','id',saved.id::text || ':lost','message',$3::text)),
	 task_state=case when parent_session_id is null then task_state else 'failed' end,updated_at=now()
	 from saved where s.id=saved.session_id returning ${SETTLED_TURN_COLUMNS}`,
		[turnId, leaseId, ABANDONED_TURN_MESSAGE],
	);
	captureSettledTurns(result.rows ?? []);
	return (result.rows?.length ?? 0) > 0;
}

/**
 * Empties the model history and whole-transcript copy of settled turns no
 * reader needs: every reader takes a chat's latest turn (the next send's
 * history, recovery, helper reports), recovery points keep their own, and
 * training keeps the turns marked eligible. Each turn row held the whole
 * conversation again (half a gigabyte for one user); batches stay small.
 */
export async function compactSettledTurns(limit = 50) {
	const result = await database().query(
		`update api_turn t set messages='[]'::jsonb,
		  items=case when jsonb_typeof(t.items)='array' then '[]'::jsonb else t.items end
		 where t.id in (select o.id from api_turn o
		  where o.state in ('completed','failed','cancelled') and not o.training_eligible
		  and o.updated_at < now() - interval '1 hour'
		  and (pg_column_size(o.messages) > 64 or pg_column_size(o.items) > 200)
		  and exists(select 1 from api_turn n where n.session_id=o.session_id and n.created_at > o.created_at)
		  order by o.created_at limit $1)`,
		[limit],
	);
	return result.rowCount ?? 0;
}

/** A turn this lease still owns, read again between a box's steps; null once it is not running. */
export async function readRunningApiTurn(
	turnId: string,
	leaseId: string,
): Promise<ApiTurn | null> {
	const result = await database().query<ApiTurn>(
		"select * from api_turn where id=$1 and lease_id=$2 and state='running'",
		[turnId, leaseId],
	);
	return result.rows[0] ?? null;
}

/** How many times a box-run turn is handed to another box after its box stopped heartbeating. */
export const MAX_BOX_TURN_TAKEOVERS = 3;

/**
 * A turn running on a box whose heartbeat stopped (the box died, lost its
 * network, or was stopped for an upgrade) goes back to the queue with the
 * progress it saved, for another box to claim under a new lease (the old
 * lease's writes are then refused). After MAX_BOX_TURN_TAKEOVERS it is left
 * to expireApiTurnLeases, which fails it. A turn asked to stop is not resumed.
 */
export async function requeueInterruptedBoxTurns() {
	const result = await database().query(
		`update api_turn set state='queued',run_attempts=run_attempts+1,updated_at=now()
		 where state='running' and executor='node' and not cancel_requested
		 and run_attempts < $1 and heartbeat_at < now()-interval '45 seconds'`,
		[MAX_BOX_TURN_TAKEOVERS],
	);
	return result.rowCount ?? 0;
}

export async function expireApiTurnLeases() {
	await requeueInterruptedBoxTurns();
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

/**
 * The Freestyle identity the turn's runner box uses for its workspace tools
 * (claude-box-tool-grant.ts), or null. Only its id is kept; never the token.
 */
export async function turnBoxToolIdentity(
	turnId: string,
	/** Only while this lease still owns the turn: a lost attempt never revokes its successor's grant. */
	leaseId?: string | null,
): Promise<string | null> {
	const result = await database().query<{ box_tool_identity: string | null }>(
		"select box_tool_identity from api_turn where id=$1 and ($2::text is null or lease_id::text=$2::text)",
		[turnId, leaseId ?? null],
	);
	return result.rows[0]?.box_tool_identity ?? null;
}

/**
 * Records a new identity on a turn this lease still runs and that holds none;
 * false otherwise (the identity must then be deleted, not used).
 */
export async function recordTurnBoxToolIdentity(
	turnId: string,
	leaseId: string,
	identityId: string,
): Promise<boolean> {
	const result = await database().query(
		`update api_turn set box_tool_identity=$3
		 where id=$1 and lease_id=$2 and state='running' and box_tool_identity is null`,
		[turnId, leaseId, identityId],
	);
	return (result.rowCount ?? 0) > 0;
}

/** Forgets a deleted identity, only if the turn still names that one. */
export async function clearTurnBoxToolIdentity(
	turnId: string,
	identityId: string,
): Promise<void> {
	await database().query(
		"update api_turn set box_tool_identity=null where id=$1 and box_tool_identity=$2",
		[turnId, identityId],
	);
}

/**
 * Identities of turns that no longer run: settled, or whose lease lapsed
 * (no renewal for 3 minutes, as expireApiTurnLeases counts it). A step that
 * still owns its turn deletes its own identity; these are what it could not.
 */
export async function staleTurnBoxToolIdentities(
	limit = 50,
): Promise<{ turnId: string; identityId: string }[]> {
	const result = await database().query<{
		id: string;
		box_tool_identity: string;
	}>(
		`select id,box_tool_identity from api_turn
		 where box_tool_identity is not null
		 and (state<>'running' or heartbeat_at < now()-interval '3 minutes')
		 order by updated_at limit $1`,
		[limit],
	);
	return result.rows.map((row) => ({
		turnId: row.id,
		identityId: row.box_tool_identity,
	}));
}
