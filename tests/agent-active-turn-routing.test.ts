import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { saveAgentTaskBlockedEvent } from "../src/server/adapters/agent-task-events";
import { hasActiveApiTurn } from "../src/server/adapters/api-turns";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
const child = "11111111-1111-4111-8111-111111111111";
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`
		create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,task_state text,turn_status text,updated_at timestamptz);
		create table api_turn(session_id uuid,user_id text,state text);
		create table agent_task_event(id uuid,user_id text,parent_session_id uuid,child_session_id uuid,event_type text,dedupe_key text unique,payload jsonb);
		insert into agent_session values('${child}','owner','22222222-2222-4222-8222-222222222222','working','running',now());
	`);
});
afterAll(async () => db.close());
it.each(["queued", "running", "completed", "failed", "cancelled"])(
	"routes only owner-scoped active turns (%s)",
	async (state) => {
		await db.exec("truncate api_turn");
		await db.query("insert into api_turn values($1,'owner',$2)", [
			child,
			state,
		]);
		expect(await hasActiveApiTurn("owner", child)).toBe(
			state === "queued" || state === "running",
		);
		expect(await hasActiveApiTurn("other-owner", child)).toBe(false);
	},
);
it.each(["running", "completed"])(
	"blocked reporting preserves execution status for a %s turn",
	async (state) => {
		await db.exec("truncate api_turn,agent_task_event");
		await db.query("insert into api_turn values($1,'owner',$2)", [
			child,
			state,
		]);
		await saveAgentTaskBlockedEvent({
			sessionId: child,
			question: "Which contract applies?",
		});
		const result = await db.query<{ task_state: string; turn_status: string }>(
			"select task_state,turn_status from agent_session where id=$1",
			[child],
		);
		expect(result.rows[0]).toEqual({
			task_state: "waiting",
			turn_status: state === "running" ? "running" : "idle",
		});
	},
);
