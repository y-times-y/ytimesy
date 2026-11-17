import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { claudeCodeTurnRevision } from "../src/domain/claude-code-route";
import { SessionItemId } from "../src/domain/ids";
import { subscriptionTurnRevision } from "../src/domain/subscription-turn";
import {
	cancelApiTurn,
	checkpointApiTurn,
	claimApiTurn,
	enqueueApiTurn,
	expireApiTurnLeases,
	finalizeApiTurn,
	finishApiTurn,
	previousTurnHistory,
	previousTurnMessages,
	publishApiTurnProgress,
	releaseClaimedApiTurn,
	renewApiTurn,
	renewParkedClaudeTurn,
	TurnBaseChanged,
} from "../src/server/adapters/api-turns";
import {
	reserveApiTokens,
	reserveEnvironmentDiagnosisTokens,
} from "../src/server/adapters/api-usage-budget";
import {
	claimConversationDeliveries,
	conversationSnapshot,
	settleConversationDelivery,
} from "../src/server/adapters/conversation-delivery";
import {
	loadModelFailoverPreferences,
	saveModelFailoverPreferences,
} from "../src/server/adapters/model-failover-preferences";
import {
	injectServerPeerMessages,
	serverPeerMessageAccepted,
	stageServerPeerMessage,
} from "../src/server/adapters/server-peer-inbox";

let db: PGlite;
const query = async (sql: string, values: unknown[] = []) => {
	// A parameterless batch of statements goes as one simple query, like
	// node-postgres sends it: one result per statement.
	if (!values.length && sql.trim().split(/;\s*\n/).length > 1)
		return (await db.exec(sql)).map((result) => ({
			...result,
			rowCount: result.affectedRows ?? result.rows.length,
		})) as unknown as Awaited<ReturnType<typeof db.query>> & {
			rowCount: number;
		};
	const result = await db.query(sql, values);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
const sessionId = randomUUID();
const connectionId = randomUUID();
const revision = randomUUID();
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	create table agent_account(user_id text,provider text,status text,encrypted_codex_auth text); insert into agent_account values('alice','codex','connected','sealed-fixture');
	create table workspace(id text primary key,user_id text); insert into workspace values('environment','alice');
	create table auth_user(id text primary key); insert into auth_user values('alice'),('bob');
	create table agent_session(id uuid primary key,user_id text references auth_user(id),parent_session_id uuid references agent_session(id),harness text constraint agent_session_harness_check check(harness in ('codex','claude','opencode')),turn_status text,listed_model_id text,items jsonb default '[]',task_state text,task_access text,updated_at timestamptz default now());`);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927183000_model_connections.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile("supabase/migrations/20260927203000_api_turns.sql", "utf8"),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261008120000_api_turn_executor.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261014020000_api_turn_settings.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261005160000_agent_pr_repair.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261014060000_model_failover.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261001120000_conversation_delivery.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261026100000_agent_session_item.sql",
			"utf8",
		),
	);
	for (const file of [
		"20261105100000_agent_session_items_rev",
		"20261114120000_conversation_delivery_items_rev",
		"20261115120000_turn_runner_box",
		"20261115200000_api_turn_base",
		"20261117120000_turn_runner_box_revocation",
	])
		await db.exec(await readFile(`supabase/migrations/${file}.sql`, "utf8"));
	await db.exec(
		await readFile(
			"supabase/migrations/20261017130000_queued_user_messages.sql",
			"utf8",
		),
	);
	// Training consent reads the chat's project; this schema builds both minimally.
	await db.exec(
		"create table project(id uuid primary key,user_id text); alter table agent_session add column project_id uuid references project(id)",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261019150000_training_consent.sql",
			"utf8",
		),
	);
	// Box routing reads these (boxRoutingFacts, evaluationRunForTask); the rows are not needed, the tables are.
	await db.exec(
		"create table if not exists project_secret(project_id uuid, kind text); create table if not exists account_secret(user_id text, kind text); create table if not exists harness_evaluation_run(root_session_id uuid, user_id text)",
	);
	await db.query(
		`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,revision) values($1,'alice','openrouter','Test','https://openrouter.ai/api/v1','fixture',$2)`,
		[connectionId, revision],
	);
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "node");
	await db.exec("truncate api_turn,agent_session,api_usage_budget cascade");
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','codex','idle')",
		[sessionId],
	);
});
afterAll(() => db.close());
function submit(userId = "alice", targetSessionId = sessionId) {
	return enqueueApiTurn({
		sessionId: targetSessionId,
		userId,
		connectionId,
		revision,
		modelId: "test-model",
		routeId: `api/${connectionId}/test-model`,
		messages: [{ role: "user", content: "test" }],
		items: [],
	});
}

it("loads and checkpoints only the active visible turn while retaining every archived item", async () => {
	const { activeTurnHistory } = await import(
		"../src/server/adapters/active-turn-history"
	);
	await submit();
	const turn = await claimApiTurn();
	if (!turn?.lease_id) throw new Error("Missing turn lease");
	const archived = Array.from({ length: 60 }, (_, index) => ({
		kind: "agentMessage",
		id: `archive-${index}`,
		text: "historical payload ".repeat(3_000),
	}));
	const active = [
		{ kind: "userMessage", id: "work-77", text: "new work" },
		{ kind: "agentMessage", id: "answer-77", text: "in progress" },
	];
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify([...archived, ...active]),
	]);
	await db.query("update api_turn set items=$2::jsonb where id=$1", [
		turn.id,
		JSON.stringify({ from: "work-77" }),
	]);
	const loaded = await activeTurnHistory(turn.id, turn.lease_id, "work-77");
	expect(loaded?.items).toEqual(active);
	expect(JSON.stringify(loaded)).not.toContain("historical payload");
	if (!loaded) throw new Error("Missing active history");
	const finished = {
		kind: "agentMessage",
		id: "answer-78",
		text: "finished",
	} as never;
	await checkpointApiTurn(
		{ ...turn, items: loaded.items, items_from: "work-77" },
		loaded.messages,
		[...loaded.items, finished],
	);
	const stored = await db.query<{ items: unknown[] }>(
		"select items from agent_session where id=$1",
		[sessionId],
	);
	expect(stored.rows[0].items).toEqual([...archived, ...active, finished]);
	const baseTurnId = randomUUID();
	const prefix = [{ role: "user" as const, content: "saved model prefix" }];
	const suffix = [{ role: "assistant" as const, content: "new model suffix" }];
	await db.query(
		"update api_turn set messages=$2::jsonb,base_turn_id=$3,base_version='fixture-v7',base_count=1 where id=$1",
		[turn.id, JSON.stringify([...prefix, ...suffix]), baseTurnId],
	);
	const read = vi.spyOn(db, "query");
	try {
		expect(
			(
				await activeTurnHistory(turn.id, turn.lease_id, "work-77", {
					turnId: baseTurnId,
					version: "fixture-v7",
					settled: false,
					messages: prefix,
				})
			)?.messages,
		).toEqual([...prefix, ...suffix]);
		const raw = await read.mock.results[0].value;
		expect(raw.rows[0]).toMatchObject({ messages: suffix, messages_after: 1 });
	} finally {
		read.mockRestore();
	}
	expect(
		(
			await activeTurnHistory(turn.id, turn.lease_id, "work-77", {
				turnId: baseTurnId,
				version: "wrong-version",
				settled: false,
				messages: prefix,
			})
		)?.messages,
	).toEqual([...prefix, ...suffix]);
	expect(await activeTurnHistory(turn.id, randomUUID(), "work-77")).toBeNull();
	expect(
		await activeTurnHistory(turn.id, turn.lease_id, "missing-marker"),
	).toBeNull();
});

it("stamps training eligibility when the turn is queued, off by default", async () => {
	const projectId = randomUUID();
	await db.query("insert into project(id,user_id) values($1,'alice')", [
		projectId,
	]);
	await db.query("update agent_session set project_id=$1 where id=$2", [
		projectId,
		sessionId,
	]);
	const eligible = async () =>
		(
			await query(
				"select training_eligible from api_turn order by created_at desc limit 1",
			)
		).rows[0];
	await submit();
	expect(await eligible()).toEqual({ training_eligible: false });
	const reset = () =>
		db.exec("truncate api_turn; update agent_session set turn_status='idle'");
	await reset();
	await db.query(
		"insert into training_consent(user_id,enabled,policy_version,source) values('alice',true,'v','settings')",
	);
	await submit();
	expect(await eligible()).toEqual({ training_eligible: true });
	await reset();
	await db.query("update project set training_excluded=true where id=$1", [
		projectId,
	]);
	await submit();
	expect(await eligible()).toEqual({ training_eligible: false });
	await db.exec(
		"delete from training_consent; update agent_session set project_id=null; delete from project",
	);
});

it("assigns one immutable executor when admitting a turn", async () => {
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
	await submit();
	expect(await claimApiTurn(2, 8, "node")).toBeNull();
	const turn = await claimApiTurn(2, 8, "durable-object");
	expect(turn).not.toBeNull();
	expect(
		(await query("select executor from api_turn where id=$1", [turn?.id]))
			.rows[0],
	).toEqual({ executor: "durable-object" });
	await expect(
		query("update api_turn set executor='node' where id=$1", [turn?.id]),
	).rejects.toThrow("cannot change executor");
	await query("update api_turn set state='completed' where id=$1", [turn?.id]);
	await expect(
		query("update api_turn set executor='node' where id=$1", [turn?.id]),
	).rejects.toThrow("cannot change executor");
});

it("queues a claimed turn again after a failed hand-off, fenced by the lease it was claimed with", async () => {
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
	await submit();
	const turn = await claimApiTurn(2, 8, "durable-object");
	if (!turn?.lease_id) throw new Error("not claimed");
	// A stale lease releases nothing.
	expect(await releaseClaimedApiTurn(turn.id, randomUUID())).toBe(false);
	expect(await releaseClaimedApiTurn(turn.id, turn.lease_id)).toBe(true);
	expect(
		(await query("select state,lease_id from api_turn where id=$1", [turn.id]))
			.rows[0],
	).toEqual({ state: "queued", lease_id: null });
	// The next admission takes it again, under a new lease; the old one is dead.
	const again = await claimApiTurn(2, 8, "durable-object");
	expect(again?.id).toBe(turn.id);
	expect(again?.lease_id).not.toBe(turn.lease_id);
	expect(await releaseClaimedApiTurn(turn.id, turn.lease_id)).toBe(false);
	expect(
		await renewApiTurn({ ...turn, lease_id: turn.lease_id } as never),
	).toBe(false);
});

it("does not let the Cloudflare dispatcher claim a legacy Node turn", async () => {
	await submit();
	expect(await claimApiTurn(2, 8, "durable-object")).toBeNull();
	expect(await claimApiTurn(2, 8, "node")).not.toBeNull();
});

it("isolated admission cannot claim another chat's queued turn", async () => {
	const otherSessionId = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','codex','idle')",
		[otherSessionId],
	);
	await submit();
	await submit("alice", otherSessionId);
	const turn = await claimApiTurn(2, 8, "node", otherSessionId);
	expect(turn?.session_id).toBe(otherSessionId);
	expect(
		(await query("select state from api_turn where session_id=$1", [sessionId]))
			.rows[0],
	).toEqual({ state: "queued" });
});

it("recovers a lost repair wakeup acknowledgement without queuing a second turn", async () => {
	const input = {
		sessionId,
		userId: "alice",
		connectionId,
		revision,
		modelId: "test-model",
		routeId: `api/${connectionId}/test-model`,
		messages: [{ role: "user" as const, content: "repair" }],
		items: [],
		idempotencyKey: "repair-unique",
	};
	await enqueueApiTurn(input);
	await enqueueApiTurn(input);
	expect((await db.query("select * from api_turn")).rows).toHaveLength(1);
});

it("admits another user's queued work when one user reaches their shared worker limit", async () => {
	const second = randomUUID();
	const third = randomUUID();
	const other = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','api','idle'),($2,'alice','api','idle'),($3,'bob','api','idle')",
		[second, third, other],
	);
	await submit();
	await submit("alice", second);
	await submit("alice", third);
	expect((await claimApiTurn(2))?.user_id).toBe("alice");
	expect((await claimApiTurn(2))?.user_id).toBe("alice");
	await db.query(
		"insert into api_turn(id,session_id,user_id,model_id,connection_revision,state) values($1,$2,'bob','fixture','fixture','queued')",
		[randomUUID(), other],
	);
	expect((await claimApiTurn(2))?.user_id).toBe("bob");
	expect(await claimApiTurn(2)).toBeNull();
});

it("shares a fleet ceiling across dispatchers and releases it when a turn settles", async () => {
	const second = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','api','idle')",
		[second],
	);
	await submit();
	await submit("alice", second);
	const first = await claimApiTurn(8, 1);
	expect(first).not.toBeNull();
	expect(await claimApiTurn(8, 1)).toBeNull();
	if (!first) throw new Error("Missing first turn");
	await finalizeApiTurn(first, "completed", []);
	expect(await claimApiTurn(8, 1)).not.toBeNull();
});

it.each([0, NaN, 10_001])(
	"rejects invalid fleet dispatch ceiling %s",
	async (limit) => {
		await expect(claimApiTurn(8, limit)).rejects.toThrow("bounded integers");
	},
);

it("does not acknowledge peer input until the actual model history is checkpointed", async () => {
	await stageServerPeerMessage(sessionId, "peer-one", "Finding from a peer");
	await expect(
		injectServerPeerMessages(sessionId, [], async () => {
			throw new Error("DB outage");
		}),
	).rejects.toThrow("DB outage");
	expect(await serverPeerMessageAccepted(sessionId, "peer-one")).toBe(false);
	const saved: unknown[] = [];
	const history = await injectServerPeerMessages(
		sessionId,
		[],
		async (messages) => {
			saved.push(messages);
		},
	);
	expect(saved).toEqual([[{ role: "user", content: "Finding from a peer" }]]);
	expect(await serverPeerMessageAccepted(sessionId, "peer-one")).toBe(true);
	expect(
		await injectServerPeerMessages(sessionId, history, async () => {
			throw new Error("Should not checkpoint twice");
		}),
	).toEqual(history);
});

it("keeps context usage when a large turn pushes its user message outside the delivered page", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw new Error("Missing turn");
	const usage = {
		compacting: false,
		context: { last: { totalTokens: 87654 }, modelContextWindow: 400000 },
	};
	await publishApiTurnProgress(turn, [
		{
			kind: "userMessage",
			id: SessionItemId("usage-source"),
			text: "Inspect orbital routes",
			contextUsage: usage,
		},
		...Array.from({ length: 301 }, (_, index) => ({
			kind: "agentMessage" as const,
			id: SessionItemId(`orbit-${index}`),
			text: `Finding ${index}`,
		})),
	]);
	const delivered = await conversationSnapshot("alice", sessionId);
	expect(delivered?.progress.items).toHaveLength(200);
	expect(
		delivered?.progress.items.some(
			(item) => (item as { id: string }).id === "usage-source",
		),
	).toBe(false);
	expect(delivered?.progress.usage).toEqual(usage);
	expect(delivered?.progress.hasOlderItems).toBe(true);
	const [claimed] = await claimConversationDeliveries();
	// No delivery reached its room yet: the first one is a full snapshot.
	expect("progress" in claimed.update && claimed.update.progress.usage).toEqual(
		usage,
	);
});

it("coalesces streamed checkpoints into one recoverable owner-scoped mailbox", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw new Error("Missing turn");
	await publishApiTurnProgress(turn, [
		{ kind: "agentMessage", id: SessionItemId("text"), text: "First" },
	]);
	const first = await conversationSnapshot("alice", sessionId);
	await publishApiTurnProgress(turn, [
		{
			kind: "agentMessage",
			id: SessionItemId("text"),
			text: "First and second",
		},
	]);
	const next = await conversationSnapshot("alice", sessionId);
	expect(BigInt(next?.revision ?? "0")).toBeGreaterThan(
		BigInt(first?.revision ?? "0"),
	);
	expect(next?.progress.items).toEqual([
		{ kind: "agentMessage", id: "text", text: "First and second" },
	]);
	expect(await conversationSnapshot("bob", sessionId)).toBeNull();
	expect(
		(await db.query("select * from conversation_delivery")).rows,
	).toHaveLength(1);
	const deliveries = await claimConversationDeliveries();
	expect(deliveries).toHaveLength(1);
	await publishApiTurnProgress(turn, []);
	await settleConversationDelivery(deliveries[0], true);
	expect(await claimConversationDeliveries()).toHaveLength(1);
});

it("rejects streaming after cancellation or expiry without advancing delivery", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw new Error("Missing turn");
	await db.query(
		"update api_turn set heartbeat_at=now()-interval '46 seconds' where id=$1",
		[turn.id],
	);
	await expect(publishApiTurnProgress(turn, [])).rejects.toThrow("lease");
	expect(await renewApiTurn(turn)).toBe(false);
	expect(await finalizeApiTurn(turn, "completed", [])).toBeNull();
	await db.query("update api_turn set heartbeat_at=now() where id=$1", [
		turn.id,
	]);
	await cancelApiTurn("alice", sessionId);
	await expect(publishApiTurnProgress(turn, [])).rejects.toThrow("cancelled");
	expect(await finalizeApiTurn(turn, "completed", [])).toBe("cancelled");
	expect(
		(
			await db.query("select turn_status from agent_session where id=$1", [
				sessionId,
			])
		).rows,
	).toEqual([{ turn_status: "idle" }]);
});

it("backs off a failed room without blocking another room", async () => {
	const other = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'bob','api','idle')",
		[other],
	);
	const deliveries = await claimConversationDeliveries();
	expect(deliveries).toHaveLength(2);
	const failed = deliveries.find(
		(value) => value.update.sessionId === sessionId,
	);
	const successful = deliveries.find(
		(value) => value.update.sessionId === other,
	);
	if (!failed || !successful) throw new Error("Missing delivery");
	await settleConversationDelivery(failed, false);
	await settleConversationDelivery(successful, true);
	await db.query("update agent_session set items='[]' where id=$1", [
		sessionId,
	]);
	// New streamed frames must not erase a failed room's retry deadline.
	expect(await claimConversationDeliveries()).toHaveLength(0);
	await db.query("update agent_session set items='[]' where id=$1", [other]);
	expect(
		(await claimConversationDeliveries()).map(
			(value) => value.update.sessionId,
		),
	).toEqual([other]);
});

it("runs the durable subscription lifecycle without a model_connection and keeps the Codex identity", async () => {
	await enqueueApiTurn({
		sessionId,
		userId: "alice",
		connectionId: null,
		revision: subscriptionTurnRevision("high"),
		modelId: "subscription-model",
		routeId: "subscription-model",
		messages: [{ role: "user", content: "test" }],
		items: [],
	});
	const turn = await claimApiTurn();
	expect(turn).toMatchObject({
		connection_id: null,
		model_id: "subscription-model",
		state: "running",
	});
	if (!turn) throw new Error("Missing turn");
	expect(await renewApiTurn(turn)).toBe(true);
	await checkpointApiTurn(turn, [{ role: "assistant", content: "done" }], []);
	expect(await finishApiTurn(turn, "completed", [])).toBe(true);
	expect(
		(
			await db.query(
				"select harness,turn_status from agent_session where id=$1",
				[sessionId],
			)
		).rows,
	).toEqual([{ harness: "codex", turn_status: "completed" }]);
});

it("rejects another owner's subscription before queue insertion", async () => {
	await expect(
		enqueueApiTurn({
			sessionId,
			userId: "bob",
			connectionId: null,
			revision: subscriptionTurnRevision(),
			modelId: "subscription-model",
			routeId: "subscription-model",
			messages: [],
			items: [],
		}),
	).rejects.toThrow("no longer available");
	expect((await db.query("select id from api_turn")).rows).toHaveLength(0);
});
it("bounds environment diagnosis separately and rolls back account reservations on denial", async () => {
	await reserveEnvironmentDiagnosisTokens("alice", "environment", 90_000);
	await expect(
		reserveEnvironmentDiagnosisTokens("alice", "environment", 20_000),
	).rejects.toThrow("safety budget");
	await expect(
		reserveEnvironmentDiagnosisTokens("bob", "environment", 1),
	).rejects.toThrow("not available");
	const budgets = await db.query<{ reserved_tokens: number }>(
		"select reserved_tokens from api_usage_budget where user_id='alice'",
	);
	expect(budgets.rows.map((row) => Number(row.reserved_tokens))).toEqual([
		90_000, 90_000,
	]);
});
it("switches runtime on the same session and freezes the model on the queued turn", async () => {
	await submit();
	const turn = await claimApiTurn();
	expect(turn).toMatchObject({
		session_id: sessionId,
		model_id: "test-model",
		connection_revision: revision,
	});
	expect(
		(await db.query("select harness,turn_status from agent_session")).rows[0],
	).toEqual({ harness: "api", turn_status: "running" });
	expect(await claimApiTurn()).toBeNull();
	await expect(submit()).rejects.toThrow("Finish or stop");
});
it("answers a replayed send to a running chat without queueing it again", async () => {
	const send = () =>
		enqueueApiTurn({
			sessionId,
			userId: "alice",
			connectionId,
			revision,
			modelId: "test-model",
			routeId: `api/${connectionId}/test-model`,
			messages: [{ role: "user", content: "test" }],
			items: [],
			idempotencyKey: "replayed-send",
		});
	await send();
	// The chat now runs that turn; the same send is answered, not refused.
	await send();
	expect((await db.query("select id from api_turn")).rows).toHaveLength(1);
});

it("queues a prepared subagent's first turn while its row already shows it working", async () => {
	const child = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,harness,turn_status,task_state) values($1,'alice',$2,'api','running','working')",
		[child, sessionId],
	);
	const queue = (preparedTask: boolean) =>
		enqueueApiTurn({
			sessionId: child,
			userId: "alice",
			connectionId,
			revision,
			modelId: "test-model",
			routeId: `api/${connectionId}/test-model`,
			messages: [{ role: "user", content: "brief" }],
			items: [],
			preparedTask,
		});
	await expect(queue(false)).rejects.toThrow("Finish or stop");
	await queue(true);
	expect((await db.query("select session_id from api_turn")).rows).toEqual([
		{ session_id: child },
	]);
});

it("rejects another owner's session", async () => {
	await expect(submit("bob")).rejects.toThrow();
	expect(await claimApiTurn()).toBeNull();
});
it("checkpoints usage through reconnect and failed completion without a schema change", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw new Error("Missing turn");
	const apiUsage = {
		inputTokens: 100,
		outputTokens: 10,
		uncachedInputTokens: null,
		cacheReadTokens: 80,
		cacheWriteTokens: null,
	};
	const items = [
		{
			kind: "userMessage" as const,
			id: SessionItemId("prompt"),
			text: "Fixture",
			apiUsage,
		},
	];
	await checkpointApiTurn(turn, [], items);
	expect(
		(
			await db.query<{ items: unknown }>(
				"select items from agent_session where id=$1",
				[sessionId],
			)
		).rows[0].items,
	).toEqual(items);
	await finishApiTurn(turn, "failed", items);
	expect(
		(
			await db.query<{ items: unknown }>(
				"select items from api_turn where id=$1",
				[turn.id],
			)
		).rows[0].items,
	).toEqual(items);
});
it("rejects a connection belonging to another owner", async () => {
	await db.query("update agent_session set user_id='bob' where id=$1", [
		sessionId,
	]);
	await expect(submit("bob")).rejects.toThrow("connection");
	expect(await claimApiTurn()).toBeNull();
});
it("retains turn history when its connection is deleted", async () => {
	await submit();
	await db.exec("begin");
	try {
		await db.query("delete from model_connection where id=$1", [connectionId]);
		expect(
			(await db.query("select connection_id from api_turn")).rows[0],
		).toEqual({ connection_id: null });
	} finally {
		await db.exec("rollback");
	}
});
it("cancels a running turn on the heartbeat once its runner deadline passes", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	await db.query(
		"insert into agent_task_command_receipt values($1,'turn-deadline','done',$2::jsonb)",
		[sessionId, JSON.stringify({ deadlineAt: Date.now() + 60_000 })],
	);
	expect(await renewApiTurn(turn)).toBe(true);
	await db.query(
		"update agent_task_command_receipt set response=$2::jsonb where parent_session_id=$1",
		[sessionId, JSON.stringify({ deadlineAt: Date.now() - 1000 })],
	);
	expect(await renewApiTurn(turn)).toBe(false);
	expect(
		(
			await db.query("select cancel_requested from api_turn where id=$1", [
				turn.id,
			])
		).rows[0],
	).toEqual({ cancel_requested: true });
	expect(await finalizeApiTurn(turn, "completed", [])).toBe("cancelled");
	await db.exec("delete from agent_task_command_receipt");
});
it("stops after cancellation and fences late checkpoints after completion", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	expect(await renewApiTurn(turn)).toBe(true);
	await cancelApiTurn("bob", sessionId);
	expect(await renewApiTurn(turn)).toBe(true);
	await cancelApiTurn("alice", sessionId);
	expect(await renewApiTurn(turn)).toBe(false);
	await finishApiTurn(turn, "cancelled", []);
	await expect(checkpointApiTurn(turn, [], [])).rejects.toThrow("lease");
	expect(
		(await db.query("select turn_status from agent_session")).rows[0],
	).toEqual({ turn_status: "idle" });
});
it("keeps a stopped step's started tool call in the history the next turn continues", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	const call = {
		type: "tool-call" as const,
		toolCallId: "call-1",
		toolName: "run",
		input: { command: "sleep 60; echo marker-one" },
	};
	const inFlight = [
		{ role: "user" as const, content: "test" },
		{ role: "assistant" as const, content: [call] },
	];
	await cancelApiTurn("alice", sessionId);
	// Checkpoints are fenced once a stop is requested; settling is not.
	await expect(checkpointApiTurn(turn, inFlight, [])).rejects.toThrow("lease");
	expect(await finalizeApiTurn(turn, "cancelled", [], inFlight)).toBe(
		"cancelled",
	);
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
	expect(
		await previousTurnMessages("alice", sessionId, "test-model", revision),
	).toEqual([
		...inFlight,
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "run",
					output: {
						type: "error-text",
						value: expect.stringContaining("the turn was stopped"),
					},
				},
			],
		},
	]);
});
it("keeps the last checkpoint when a turn settles without in-flight calls", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	await finalizeApiTurn(turn, "failed", []);
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
	expect(
		await previousTurnMessages("alice", sessionId, "test-model", revision),
	).toEqual([{ role: "user", content: "test" }]);
});
it("fails expired leases instead of replaying uncertain side effects", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	// A box-run turn is handed to another box a few times first
	// (requeueInterruptedBoxTurns); once those are used up, or for any other
	// executor, a lost turn is failed, never replayed.
	await db.exec("update api_turn set run_attempts=3");
	await db.exec("update api_turn set heartbeat_at=now()-interval '1 minute'");
	await expireApiTurnLeases();
	expect(await claimApiTurn()).toBeNull();
	expect(await renewApiTurn(turn)).toBe(false);
	expect(
		(await db.query("select turn_status from agent_session")).rows[0],
	).toEqual({ turn_status: "failed" });
});
it("shares a root task budget with children and rolls back a rejected account reservation", async () => {
	vi.stubEnv("YTIMESY_API_TASK_DAILY_TOKENS", "500000");
	const childId = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,harness,turn_status) values($1,'alice',$2,'api','idle')",
		[childId, sessionId],
	);
	await reserveApiTokens("alice", sessionId, 300_000);
	await expect(reserveApiTokens("alice", childId, 300_000)).rejects.toThrow(
		"budget reached",
	);
	expect(
		(
			await db.query(
				"select reserved_tokens from api_usage_budget where scope='account'",
			)
		).rows[0],
	).toMatchObject({ reserved_tokens: 300000 });
	await expect(reserveApiTokens("bob", sessionId, 10)).rejects.toThrow(
		"hierarchy",
	);
	vi.unstubAllEnvs();
});

it("moves a running turn to its fallback in one fenced checkpoint and keeps the chosen route", async () => {
	const revisionText = subscriptionTurnRevision("high");
	await enqueueApiTurn({
		sessionId,
		userId: "alice",
		connectionId: null,
		revision: revisionText,
		modelId: "gpt-6.1-sol",
		routeId: "gpt-6.1-sol",
		messages: [{ role: "user", content: "test" }],
		items: [],
	});
	const turn = await claimApiTurn();
	if (!turn) throw new Error("Missing turn");
	expect(turn.failover).toBeNull();
	const failover = {
		route: {
			connectionId,
			connectionRevision: revision,
			modelId: "openai/gpt-6.1-sol",
			settings: {},
		},
		label: { model: "GPT-6.1 Sol", connection: "Test" },
		tried: ["codex|gpt-6.1-sol", `${connectionId}|openai/gpt-6.1-sol`],
		triedLabels: ["GPT-6.1-Sol via Codex", "GPT-6.1 Sol via Test"],
		switches: 1,
	};
	const history = [
		{ role: "user" as const, content: "test" },
		{
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "",
					providerOptions: { anthropic: { signature: "sig" } },
				},
				{ type: "text" as const, text: "done" },
			],
		},
	];
	await checkpointApiTurn(turn, history, [], failover);
	// A later checkpoint without a failover keeps the turn on its fallback.
	await checkpointApiTurn(turn, history, []);
	const row = (
		await db.query<{
			failover: unknown;
			connection_id: string | null;
			model_id: string;
		}>("select failover,connection_id,model_id from api_turn where id=$1", [
			turn.id,
		])
	).rows[0];
	expect(row).toEqual({
		failover,
		connection_id: null,
		model_id: "gpt-6.1-sol",
	});
	expect(await finishApiTurn(turn, "completed", [])).toBe(true);
	// No recovery point exists; the previous turn's history is the source.
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
	// The next message returns to the chosen model with a history it can read.
	expect(
		await previousTurnMessages("alice", sessionId, "gpt-6.1-sol", revisionText),
	).toEqual([
		{ role: "user", content: "test" },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	]);
});

it("stores failover preferences per user with safe defaults", async () => {
	expect(await loadModelFailoverPreferences("bob")).toEqual({
		enabled: true,
		askBeforePaid: false,
		connectionOrder: [],
	});
	await saveModelFailoverPreferences("bob", {
		enabled: true,
		askBeforePaid: true,
		connectionOrder: [connectionId, "codex", connectionId],
	});
	expect(await loadModelFailoverPreferences("bob")).toEqual({
		enabled: true,
		askBeforePaid: true,
		connectionOrder: [connectionId, "codex"],
	});
	await expect(
		saveModelFailoverPreferences("bob", {
			enabled: true,
			askBeforePaid: false,
			connectionOrder: ["not-a-connection"],
		}),
	).rejects.toThrow();
});

it("queues a send only behind a running turn and shows it until a step takes it", async () => {
	const {
		queueUserMessageWhileRunning,
		takeNextQueuedUserMessage,
		removeQueuedUserMessage,
		restoreQueuedUserMessage,
	} = await import("../src/server/adapters/queued-user-messages");
	const send = (id: string, text: string) => ({
		item: { kind: "userMessage" as const, id: SessionItemId(id), text },
		message: text,
		harnessId: "codex" as const,
		modelId: "test-model",
	});
	const first = randomUUID();
	const second = randomUUID();
	// An idle chat starts a turn instead.
	expect(
		await queueUserMessageWhileRunning("alice", sessionId, send(first, "one")),
	).toBe("not-running");
	await db.query("update agent_session set turn_status='running' where id=$1", [
		sessionId,
	]);
	// Another owner cannot queue into this chat.
	expect(
		await queueUserMessageWhileRunning("bob", sessionId, send(first, "one")),
	).toBe("not-running");
	expect(
		await queueUserMessageWhileRunning("alice", sessionId, send(first, "one")),
	).toBe("queued");
	// A replayed send is queued once.
	expect(
		await queueUserMessageWhileRunning("alice", sessionId, send(first, "one")),
	).toBe("queued");
	expect(
		await queueUserMessageWhileRunning("alice", sessionId, send(second, "two")),
	).toBe("queued");
	const snapshot = await conversationSnapshot("alice", sessionId);
	expect(snapshot?.progress.items).toEqual([
		expect.objectContaining({ id: first, queued: true }),
		expect.objectContaining({ id: second, queued: true }),
	]);
	// Nothing starts a new turn while the current one runs.
	expect(await takeNextQueuedUserMessage("alice", sessionId)).toBeNull();
	// A step delivers the first; the second stays queued.
	const delivered: unknown[] = [];
	await injectServerPeerMessages(
		sessionId,
		[],
		async (_messages, items) => {
			delivered.push(...items);
			await db.query("update agent_session set items=$2 where id=$1", [
				sessionId,
				JSON.stringify(items.slice(0, 1)),
			]);
		},
		() => false,
	);
	expect(delivered).toHaveLength(2);
	expect(await removeQueuedUserMessage("alice", sessionId, first)).toBe(false);
	expect(
		await queueUserMessageWhileRunning(
			"alice",
			sessionId,
			send(randomUUID(), "three"),
		),
	).toBe("queued");
	await db.query(
		"update agent_session set turn_status='completed' where id=$1",
		[sessionId],
	);
	const next = await takeNextQueuedUserMessage("alice", sessionId);
	expect(next?.item.text).toBe("three");
	expect(next?.message).toBe("three");
	expect(await takeNextQueuedUserMessage("alice", sessionId)).toBeNull();
	if (!next) throw new Error("expected a queued message");
	await restoreQueuedUserMessage(sessionId, next);
	expect(await takeNextQueuedUserMessage("bob", sessionId)).toBeNull();
	expect(await removeQueuedUserMessage("alice", sessionId, next.item.id)).toBe(
		true,
	);
	expect(await takeNextQueuedUserMessage("alice", sessionId)).toBeNull();
});

it("appends a send's message to the stored transcript without the caller reading it", async () => {
	const earlier = [
		{ kind: "userMessage", id: "u1", text: "first" },
		{ kind: "agentMessage", id: "a1", text: "done" },
	];
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify(earlier),
	]);
	const sent = { kind: "userMessage", id: "u2", text: "second" };
	for (const target of ["node", "durable-object"] as const) {
		vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", target);
		await db.exec("truncate api_turn cascade");
		await db.query(
			"update agent_session set items=$2::jsonb,turn_status='idle' where id=$1",
			[sessionId, JSON.stringify(earlier)],
		);
		await enqueueApiTurn({
			sessionId,
			userId: "alice",
			connectionId,
			revision,
			modelId: "test-model",
			routeId: `api/${connectionId}/test-model`,
			messages: [{ role: "user", content: "second" }],
			items: [],
			appendItems: [sent as never],
		});
		const chat = await db.query<{ items: unknown[]; rows: number }>(
			"select items,(select count(*)::int from agent_session_item where session_id=$1) as rows from agent_session where id=$1",
			[sessionId],
		);
		expect(chat.rows[0]?.items).toEqual([...earlier, sent]);
		// Its recovery point holds the transcript before the message, copied
		// in the database (the send never read it).
		const point = await db.query<{ result: Record<string, unknown> }>(
			"select response->'result' as result from agent_task_command_receipt where request_id='conversation-point:u2'",
		);
		expect(point.rows[0]?.result).toMatchObject({
			type: "conversation-point",
			userMessageId: "u2",
			prompt: "second",
			items: earlier,
			messages: [],
		});
		await db.exec("truncate agent_task_command_receipt");
		// The per-item rows (the transcript's index) follow the append.
		expect(chat.rows[0]?.rows).toBe(3);
		const turn = await db.query<{ items: unknown }>(
			"select items from api_turn where session_id=$1",
			[sessionId],
		);
		// A durable-object turn keeps only where its items start; a node turn the whole.
		expect(turn.rows[0]?.items).toEqual(
			target === "durable-object" ? { from: "u2" } : [...earlier, sent],
		);
	}
});

it("rebuilds a new turn's transcript from a copy and only the rows written since", async () => {
	const { turnHistorySince } = await import(
		"../src/server/adapters/turn-history-seed"
	);
	const { seededTranscript } = await import(
		"../src/server/edge/turn-history-cache"
	);
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
	const earlier = Array.from({ length: 40 }, (_, index) => ({
		kind: index % 2 ? "agentMessage" : "userMessage",
		id: `i${index}`,
		text: `item ${index}`,
	}));
	await db.query(
		"update agent_session set items=$2::jsonb,turn_status='idle' where id=$1",
		[sessionId, JSON.stringify(earlier)],
	);
	// The chat object's copy, as the last turn left it.
	const copyRev = (
		await db.query<{ rev: string }>(
			"select items_rev::text as rev from agent_session where id=$1",
			[sessionId],
		)
	).rows[0]?.rev as string;
	// Meanwhile one earlier item is rewritten, then a send appends its message.
	const edited = earlier.map((item, index) =>
		index === 7 ? { ...item, text: "edited" } : item,
	);
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify(edited),
	]);
	const sent = { kind: "userMessage", id: "u-new", text: "next" };
	await enqueueApiTurn({
		sessionId,
		userId: "alice",
		connectionId,
		revision,
		modelId: "test-model",
		routeId: `api/${connectionId}/test-model`,
		messages: [{ role: "user", content: "next" }],
		items: [],
		appendItems: [sent as never],
	});
	const turn = (
		await db.query<{ id: string }>(
			"select id from api_turn where session_id=$1",
			[sessionId],
		)
	).rows[0] as { id: string };
	const lease = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
	await db.query("update api_turn set lease_id=$2 where id=$1", [
		turn.id,
		lease,
	]);
	const since = await turnHistorySince(turn.id, lease, copyRev);
	expect(since?.wholeItems).toBe(false);
	// Only the edited row and the new message leave the database.
	expect(since?.changed.map((row) => row.position)).toEqual([7, 40]);
	const stored = (
		await db.query<{ items: unknown[] }>(
			"select items from agent_session where id=$1",
			[sessionId],
		)
	).rows[0]?.items;
	expect(
		seededTranscript(
			earlier as never,
			since?.count ?? -1,
			since?.changed ?? [],
		),
	).toEqual(stored);
});

it("restores a point without its own transcript copy from the stored transcript before its message", async () => {
	const { conversationPoint } = await import(
		"../src/server/adapters/conversation-recovery"
	);
	const items = [
		{ kind: "userMessage", id: "m1", text: "first" },
		{ kind: "agentMessage", id: "a1", text: "done" },
		{ kind: "userMessage", id: "m2", text: "second" },
		{ kind: "agentMessage", id: "a2", text: "done too" },
	];
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify(items),
	]);
	const point = (messageId: string) => ({
		id: `conversation-point:${messageId}`,
		ok: true,
		result: {
			type: "conversation-point",
			userMessageId: messageId,
			prompt: "second",
			messages: [{ role: "user", content: "first" }],
			modelId: "test-model",
			routeId: "route",
			revision,
		},
	});
	for (const messageId of ["m2", "gone"])
		await db.query(
			"insert into agent_task_command_receipt(parent_session_id,request_id,status,response) values($1,$2,'done',$3::jsonb)",
			[
				sessionId,
				`conversation-point:${messageId}`,
				JSON.stringify(point(messageId)),
			],
		);
	const restored = await conversationPoint("alice", sessionId, "m2");
	expect(restored?.items).toEqual(items.slice(0, 2));
	expect(restored?.messages).toEqual([{ role: "user", content: "first" }]);
	// Its message left the transcript (an earlier restore): nothing to restore.
	expect(await conversationPoint("alice", sessionId, "gone")).toBeNull();
	// Another user never reads it.
	expect(await conversationPoint("mallory", sessionId, "m2")).toBeNull();
	await db.exec("truncate agent_task_command_receipt");
});

it("empties settled turns' conversation copies except each chat's latest and training-eligible ones", async () => {
	const { compactSettledTurns } = await import(
		"../src/server/adapters/api-turns"
	);
	const big = JSON.stringify(
		Array.from({ length: 50 }, (_, index) => ({
			role: "user",
			content: `message ${index} ${"x".repeat(40)}`,
		})),
	);
	const turn = async (age: string, state: string, eligible = false) =>
		(
			await db.query<{ id: string }>(
				`insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items,training_eligible,created_at,updated_at)
				 values(gen_random_uuid(),$1,'alice',$2,$3,'m',$4,$5::jsonb,$5::jsonb,$6,now()-$7::interval,now()-$7::interval) returning id`,
				[sessionId, connectionId, revision, state, big, eligible, age],
			)
		).rows[0]?.id as string;
	const old = await turn("3 hours", "completed");
	const kept = await turn("150 minutes", "completed", true);
	const recent = await turn("10 minutes", "failed");
	const latest = await turn("2 hours", "completed");
	// The newest one is the chat's latest whatever its age (created last).
	await db.query("update api_turn set created_at=now() where id=$1", [latest]);
	expect(await compactSettledTurns()).toBe(1);
	const rows = await db.query<{
		id: string;
		messages: unknown[];
		items: unknown[];
	}>("select id,messages,items from api_turn where id = any($1::uuid[])", [
		[old, kept, recent, latest],
	]);
	const byId = new Map(rows.rows.map((row) => [row.id, row]));
	expect(byId.get(old)).toMatchObject({ messages: [], items: [] });
	for (const id of [kept, recent, latest])
		expect(byId.get(id)?.messages).toHaveLength(50);
	// Already compacted rows are not visited again.
	expect(await compactSettledTurns()).toBe(0);
});

it("reads each chat's rows written after a revision, with its length now, in one statement", async () => {
	const { itemRowsSinceForOwner } = await import(
		"../src/server/adapters/agent-sessions"
	);
	const items = Array.from({ length: 6 }, (_, index) => ({
		kind: "agentMessage",
		id: `i${index}`,
		text: `item ${index}`,
	}));
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify(items),
	]);
	const base = (
		await db.query<{ rev: string }>(
			"select items_rev::text as rev from agent_session where id=$1",
			[sessionId],
		)
	).rows[0]?.rev as string;
	await db.query("update agent_session set items=$2::jsonb where id=$1", [
		sessionId,
		JSON.stringify([
			...items.slice(0, 2),
			{ ...items[2], text: "edited" },
			...items.slice(3),
			{ kind: "agentMessage", id: "i6", text: "item 6" },
		]),
	]);
	const read = await itemRowsSinceForOwner("alice", { [sessionId]: base });
	const got = read.get(sessionId);
	expect(got?.count).toBe(7);
	expect(got?.rows.map((row) => row.position)).toEqual([2, 6]);
	// Not another user's chat, and not a revision ahead of the chat's.
	expect(
		(await itemRowsSinceForOwner("mallory", { [sessionId]: base })).size,
	).toBe(0);
	expect(
		(await itemRowsSinceForOwner("alice", { [sessionId]: "999999" })).size,
	).toBe(0);
});

it("routes an enabled user's API turn to a box only while one was seen lately", async () => {
	const { registerTurnRunnerBox, removeTurnRunnerBox } = await import(
		"../src/server/adapters/turn-runner-boxes"
	);
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
	vi.stubEnv("YTIMESY_BOX_TURN_USERS", "alice");
	const executorOf = async () => {
		await db.exec("truncate api_turn cascade");
		await db.query("update agent_session set turn_status='idle' where id=$1", [
			sessionId,
		]);
		await submit();
		return (
			await db.query<{ executor: string }>(
				"select executor from api_turn where session_id=$1",
				[sessionId],
			)
		).rows[0]?.executor;
	};
	// No box yet: the turn runs in its chat's Durable Object.
	expect(await executorOf()).toBe("durable-object");
	await registerTurnRunnerBox({ id: "box-1", capacity: 2, running: 0 });
	expect(await executorOf()).toBe("node");
	// A box that is full, or not seen for a while, takes none.
	await registerTurnRunnerBox({ id: "box-1", capacity: 2, running: 2 });
	expect(await executorOf()).toBe("durable-object");
	await registerTurnRunnerBox({ id: "box-1", capacity: 2, running: 0 });
	await db.query(
		"update turn_runner_box set last_seen_at=now()-interval '2 minutes'",
	);
	expect(await executorOf()).toBe("durable-object");
	// Another user, or a box that left, never changes the default.
	await registerTurnRunnerBox({ id: "box-1", capacity: 2, running: 0 });
	vi.stubEnv("YTIMESY_BOX_TURN_USERS", "someone-else");
	expect(await executorOf()).toBe("durable-object");
	await removeTurnRunnerBox("box-1");
	await db.exec("truncate turn_runner_box");
});

it("revokes a turn runner box: it is no longer registered, alive or active, and stays revoked", async () => {
	const {
		registerTurnRunnerBox,
		revokeTurnRunnerBox,
		turnRunnerBoxActive,
		turnRunnerBoxAlive,
	} = await import("../src/server/adapters/turn-runner-boxes");
	expect(await turnRunnerBoxActive("box-r")).toBe(true);
	expect(
		await registerTurnRunnerBox({ id: "box-r", capacity: 2, running: 0 }),
	).toBe(true);
	expect(await turnRunnerBoxAlive()).toBe(true);
	await revokeTurnRunnerBox("box-r");
	expect(await turnRunnerBoxActive("box-r")).toBe(false);
	expect(await turnRunnerBoxAlive()).toBe(false);
	// Its next heartbeat is refused and does not un-revoke it.
	expect(
		await registerTurnRunnerBox({ id: "box-r", capacity: 2, running: 0 }),
	).toBe(false);
	expect(await turnRunnerBoxActive("box-r")).toBe(false);
	// Revoking an unregistered box works too.
	await revokeTurnRunnerBox("box-never-seen");
	expect(await turnRunnerBoxActive("box-never-seen")).toBe(false);
	await db.exec("truncate turn_runner_box");
});

it("hands a turn whose box stopped heartbeating to another box, a bounded number of times", async () => {
	const { requeueInterruptedBoxTurns, MAX_BOX_TURN_TAKEOVERS } = await import(
		"../src/server/adapters/api-turns"
	);
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "node");
	await submit();
	const turn = await claimApiTurn(2, 8, "node");
	expect(turn?.state).toBe("running");
	const state = async () =>
		(
			await db.query<{ state: string; run_attempts: number }>(
				"select state,run_attempts from api_turn where session_id=$1",
				[sessionId],
			)
		).rows[0];
	// Alive: left alone.
	expect(await requeueInterruptedBoxTurns()).toBe(0);
	// Its box stops heartbeating: queued again for the next box, once per loss.
	for (let loss = 1; loss <= MAX_BOX_TURN_TAKEOVERS; loss++) {
		await db.query(
			"update api_turn set heartbeat_at=now()-interval '2 minutes' where session_id=$1",
			[sessionId],
		);
		expect(await requeueInterruptedBoxTurns()).toBe(1);
		expect(await state()).toEqual({ state: "queued", run_attempts: loss });
		const again = await claimApiTurn(2, 8, "node");
		// Claimed under a new lease, with the progress it saved.
		expect(again?.lease_id).not.toBe(turn?.lease_id);
	}
	// Past the limit the loss is left for the lease sweep, which fails it.
	await db.query(
		"update api_turn set heartbeat_at=now()-interval '2 minutes' where session_id=$1",
		[sessionId],
	);
	expect(await requeueInterruptedBoxTurns()).toBe(0);
	// A turn asked to stop is never resumed.
	await db.exec("truncate api_turn cascade");
	await db.query("update agent_session set turn_status='idle' where id=$1", [
		sessionId,
	]);
	await submit();
	await claimApiTurn(2, 8, "node");
	await db.query(
		"update api_turn set cancel_requested=true,heartbeat_at=now()-interval '2 minutes' where session_id=$1",
		[sessionId],
	);
	expect(await requeueInterruptedBoxTurns()).toBe(0);
});

it("continues a settled turn's history inside the database and seeds only the messages after it", async () => {
	const { turnHistorySince } = await import(
		"../src/server/adapters/turn-history-seed"
	);
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
	await submit();
	const first = await claimApiTurn();
	if (!first) throw Error("missing turn");
	const call = {
		type: "tool-call" as const,
		toolCallId: "call-1",
		toolName: "run",
		input: {},
	};
	const settled = [
		{ role: "user" as const, content: "test" },
		{ role: "assistant" as const, content: [call] },
		{
			role: "tool" as const,
			content: [
				{
					type: "tool-result" as const,
					toolCallId: "call-1",
					toolName: "run",
					output: { type: "text" as const, value: "ok" },
				},
			],
		},
		{ role: "assistant" as const, content: "done" },
	];
	expect(await finalizeApiTurn(first, "completed", [], settled)).toBe(
		"completed",
	);
	// Same model and credentials, every call answered: only its identity.
	const previous = await previousTurnHistory(
		"alice",
		sessionId,
		"test-model",
		revision,
	);
	const base = previous?.base;
	if (!base) throw Error("expected a base");
	expect(base).toMatchObject({ turnId: first.id, count: 4 });
	expect(previous?.messages).toBeUndefined();
	// Another model: the history itself (provider-neutral), as before.
	expect(
		(await previousTurnHistory("alice", sessionId, "other-model", revision))
			?.messages,
	).toHaveLength(4);
	const tail = [{ role: "user" as const, content: "next" }];
	const queue = () =>
		enqueueApiTurn({
			sessionId,
			userId: "alice",
			connectionId,
			revision,
			modelId: "test-model",
			routeId: `api/${connectionId}/test-model`,
			messages: tail,
			items: [],
			base,
		});
	await queue();
	const next = (
		await db.query<{
			id: string;
			messages: unknown[];
			base_turn_id: string;
			base_count: number;
		}>(
			"select id,messages,base_turn_id,base_count from api_turn where session_id=$1 and id<>$2",
			[sessionId, first.id],
		)
	).rows[0];
	expect(next?.messages).toEqual([...settled, ...tail]);
	expect(next?.base_turn_id).toBe(first.id);
	expect(next?.base_count).toBe(4);
	const lease = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
	await db.query("update api_turn set lease_id=$2 where id=$1", [
		next?.id,
		lease,
	]);
	const itemsRev = (
		await db.query<{ rev: string }>(
			"select items_rev::text as rev from agent_session where id=$1",
			[sessionId],
		)
	).rows[0]?.rev as string;
	// The chat's copy is that turn at that version: only what follows it.
	const seeded = await turnHistorySince(next?.id as string, lease, itemsRev, {
		turnId: first.id,
		version: base.version,
	});
	expect(seeded?.messages).toEqual(tail);
	expect(seeded?.messagesAfter).toBe(4);
	// A copy at another version: the whole history.
	const stale = await turnHistorySince(next?.id as string, lease, itemsRev, {
		turnId: first.id,
		version: "elsewhere",
	});
	expect(stale?.messages).toEqual([...settled, ...tail]);
	expect(stale?.messagesAfter).toBeNull();
	// A settled copy is named by its count, whatever the row's version now.
	const byCount = await turnHistorySince(next?.id as string, lease, itemsRev, {
		turnId: first.id,
		version: "elsewhere",
		settledCount: 4,
	});
	expect(byCount?.messages).toEqual(tail);
	expect(
		(
			await turnHistorySince(next?.id as string, lease, itemsRev, {
				turnId: first.id,
				version: "elsewhere",
				settledCount: 3,
			})
		)?.messagesAfter,
	).toBeNull();
	// The base changed after the send was planned: the send is refused.
	await db.query(
		"update api_turn set updated_at=now()+interval '1 second' where id=$1",
		[first.id],
	);
	await db.query("update agent_session set turn_status='idle' where id=$1", [
		sessionId,
	]);
	await expect(queue()).rejects.toBeInstanceOf(TurnBaseChanged);
});

it("plans on the history itself when the last turn left a tool call unanswered", async () => {
	await db.exec(
		"create table if not exists agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,completed_at timestamptz,created_at timestamptz not null default now(),primary key(parent_session_id,request_id))",
	);
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
	const unanswered = [
		{ role: "user" as const, content: "test" },
		{
			role: "assistant" as const,
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "open",
					toolName: "run",
					input: {},
				},
			],
		},
	];
	await finalizeApiTurn(turn, "failed", [], unanswered);
	const previous = await previousTurnHistory(
		"alice",
		sessionId,
		"test-model",
		revision,
	);
	expect(previous?.base).toBeUndefined();
	// Closed with a stand-in result, exactly as previousTurnMessages does.
	expect(previous?.messages).toEqual(
		await previousTurnMessages("alice", sessionId, "test-model", revision),
	);
	expect(previous?.messages).toHaveLength(3);
});

/** A running turn on a chat object (durable-object), made a Claude Code turn when asked. */
async function durableTurn(claude: boolean) {
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
	await submit();
	const turn = await claimApiTurn(2, 8, "durable-object");
	if (!turn?.lease_id) throw new Error("not claimed");
	if (claude)
		await db.query(
			"update api_turn set connection_id=null,connection_revision=$2 where id=$1",
			[turn.id, claudeCodeTurnRevision()],
		);
	return turn;
}
const heartbeatAgo = (turnId: string, seconds: number) =>
	db.query(
		"update api_turn set heartbeat_at=now()-make_interval(secs=>$2) where id=$1",
		[turnId, seconds],
	);

it("lets a chat object's Claude Code turn renew within 150 seconds, other turns still within 45", async () => {
	const claude = await durableTurn(true);
	// Parked: 100 s since its last renewal, still its own.
	await heartbeatAgo(claude.id, 100);
	expect(await renewApiTurn(claude)).toBe(true);
	await heartbeatAgo(claude.id, 100);
	await publishApiTurnProgress(claude, []);
	await heartbeatAgo(claude.id, 140);
	await checkpointApiTurn(claude, [{ role: "assistant", content: "ok" }], []);
	// Past its window: lost, like any stale lease.
	await heartbeatAgo(claude.id, 151);
	expect(await renewApiTurn(claude)).toBe(false);
	await expect(publishApiTurnProgress(claude, [])).rejects.toThrow("lease");
	expect(await finalizeApiTurn(claude, "completed", [])).toBeNull();
	await db.exec(
		"truncate api_turn cascade; update agent_session set turn_status='idle'",
	);

	// An API turn on the same executor keeps 45 seconds.
	const api = await durableTurn(false);
	await heartbeatAgo(api.id, 46);
	expect(await renewApiTurn(api)).toBe(false);
	await db.exec(
		"truncate api_turn cascade; update agent_session set turn_status='idle'",
	);

	// So does a Claude Code turn a box runs (executor node).
	vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "node");
	await submit();
	const box = await claimApiTurn(2, 8, "node");
	if (!box) throw new Error("not claimed");
	await db.query(
		"update api_turn set connection_id=null,connection_revision=$2 where id=$1",
		[box.id, claudeCodeTurnRevision()],
	);
	await heartbeatAgo(box.id, 46);
	expect(await renewApiTurn({ ...box, connection_id: null } as never)).toBe(
		false,
	);
});

it("expires a parked Claude Code turn only after the chat objects' three minutes", async () => {
	const turn = await durableTurn(true);
	await heartbeatAgo(turn.id, 150);
	await expireApiTurnLeases();
	expect(
		(await db.query("select state from api_turn where id=$1", [turn.id]))
			.rows[0],
	).toEqual({ state: "running" });
	await heartbeatAgo(turn.id, 181);
	await expireApiTurnLeases();
	expect(
		(await db.query("select state from api_turn where id=$1", [turn.id]))
			.rows[0],
	).toEqual({ state: "failed" });
});

it("renews a parked Claude Code turn in one statement, asking for a step when anything needs one", async () => {
	const turn = await durableTurn(true);
	const lease = turn.lease_id as string;
	await heartbeatAgo(turn.id, 100);
	expect(await renewParkedClaudeTurn(turn.id, lease)).toBe("renewed");
	expect(
		(
			await db.query<{ fresh: boolean }>(
				"select heartbeat_at>now()-interval '5 seconds' as fresh from api_turn where id=$1",
				[turn.id],
			)
		).rows[0],
	).toEqual({ fresh: true });
	// A peer message waiting: renewed, but a step should see it.
	await db.query(
		"insert into agent_peer_inbox(id,recipient_id,message) values('m1',$1,'hello')",
		[sessionId],
	);
	expect(await renewParkedClaudeTurn(turn.id, lease)).toBe("inbox");
	await db.exec("delete from agent_peer_inbox");
	// Another lease, a stale lease, or Stop: lost, and a step settles it.
	expect(await renewParkedClaudeTurn(turn.id, randomUUID())).toBe("lost");
	await heartbeatAgo(turn.id, 151);
	expect(await renewParkedClaudeTurn(turn.id, lease)).toBe("lost");
	await heartbeatAgo(turn.id, 10);
	await cancelApiTurn("alice", sessionId);
	expect(await renewParkedClaudeTurn(turn.id, lease)).toBe("lost");
});
