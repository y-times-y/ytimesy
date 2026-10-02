import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import {
	cancelApiTurn,
	checkpointApiTurn,
	claimApiTurn,
	enqueueApiTurn,
	expireApiTurnLeases,
	finishApiTurn,
	renewApiTurn,
} from "../src/server/adapters/api-turns";
import {
	reserveApiTokens,
	reserveEnvironmentDiagnosisTokens,
} from "../src/server/adapters/api-usage-budget";

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
	create table workspace(id text primary key,user_id text); insert into workspace values('environment','alice');
	create table auth_user(id text primary key); insert into auth_user values('alice'),('bob');
	create table agent_session(id uuid primary key,user_id text references auth_user(id),parent_session_id uuid references agent_session(id),harness text constraint agent_session_harness_check check(harness in ('codex','claude','opencode')),turn_status text,listed_model_id text,items jsonb default '[]',task_state text,updated_at timestamptz default now());`);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927183000_model_connections.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile("supabase/migrations/20260927203000_api_turns.sql", "utf8"),
	);
	await db.query(
		`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,revision) values($1,'alice','openrouter','Test','https://openrouter.ai/api/v1','fixture',$2)`,
		[connectionId, revision],
	);
});
beforeEach(async () => {
	await db.exec("truncate api_turn,agent_session,api_usage_budget cascade");
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','codex','idle')",
		[sessionId],
	);
});
afterAll(() => db.close());
function submit(userId = "alice") {
	return enqueueApiTurn({
		sessionId,
		userId,
		connectionId,
		revision,
		modelId: "test-model",
		routeId: `api/${connectionId}/test-model`,
		messages: [{ role: "user", content: "test" }],
		items: [],
	});
}
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
});
