import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
	publishApiTurnProgress,
	renewApiTurn,
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
	injectServerPeerMessages,
	serverPeerMessageAccepted,
	stageServerPeerMessage,
} from "../src/server/adapters/server-peer-inbox";

let db: PGlite;
const query = async (sql: string, values: unknown[] = []) => {
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
			"supabase/migrations/20261001120000_conversation_delivery.sql",
			"utf8",
		),
	);
	await db.query(
		`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,revision) values($1,'alice','openrouter','Test','https://openrouter.ai/api/v1','fixture',$2)`,
		[connectionId, revision],
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
		(value) => value.snapshot.sessionId === sessionId,
	);
	const successful = deliveries.find(
		(value) => value.snapshot.sessionId === other,
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
			(value) => value.snapshot.sessionId,
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
it("fails expired leases instead of replaying uncertain side effects", async () => {
	await submit();
	const turn = await claimApiTurn();
	if (!turn) throw Error("missing turn");
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
