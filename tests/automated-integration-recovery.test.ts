import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { recoverInterruptedTaskIntegrations } from "../src/server/adapters/agent-task-events";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, args: unknown[]) => db.query(sql, args),
	}),
}));
const parent = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const turn = "33333333-3333-4333-8333-333333333333";
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,task_state text,turn_status text,task_summary text,items jsonb,updated_at timestamptz default now()); create table api_turn(id uuid primary key,session_id uuid,user_id text,state text); create table agent_task_event(id uuid primary key,user_id text,parent_session_id uuid,child_session_id uuid,event_type text,dedupe_key text unique,payload jsonb);",
	);
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec("truncate agent_session,api_turn,agent_task_event");
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,task_state,turn_status,items) values ($1,'owner',$2,'working','running',$3)",
		[
			child,
			parent,
			JSON.stringify([
				{ kind: "userMessage", id: `${turn}:integration`, text: "Integrate" },
			]),
		],
	);
	await db.query("insert into api_turn values($1,$2,'owner','failed')", [
		turn,
		parent,
	]);
});
it("atomically frees capacity and emits one failure event without replaying execution", async () => {
	await recoverInterruptedTaskIntegrations();
	await recoverInterruptedTaskIntegrations();
	expect(
		(await db.query("select task_state,turn_status from agent_session")).rows,
	).toEqual([{ task_state: "failed", turn_status: "failed" }]);
	const events = (
		await db.query<{ payload: { message: string } }>(
			"select payload from agent_task_event",
		)
	).rows;
	expect(events).toHaveLength(1);
	expect(events[0].payload.message).toContain("not replayed");
});
it.each(["running lead", "other owner", "ordinary child", "active repair"])(
	"preserves %s",
	async (reason) => {
		if (reason === "running lead")
			await db.exec("update api_turn set state='running'");
		if (reason === "other owner")
			await db.exec("update api_turn set user_id='other'");
		if (reason === "ordinary child")
			await db.exec("update agent_session set items='[]'");
		if (reason === "active repair")
			await db.query(
				"insert into api_turn values('44444444-4444-4444-8444-444444444444',$1,'owner','running')",
				[child],
			);
		await recoverInterruptedTaskIntegrations();
		expect(
			(await db.query("select task_state from agent_session")).rows,
		).toEqual([{ task_state: "working" }]);
		expect(
			(await db.query("select * from agent_task_event")).rows,
		).toHaveLength(0);
	},
);
