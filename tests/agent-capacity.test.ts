import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	modelConcurrencyLimits,
	reserveAgentTaskStart,
} from "../src/server/adapters/agent-capacity";

let db: PGlite;
const query = async (sql: string, values: unknown[] = []) => {
	const result = await db.query(sql, values);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query }),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id text primary key,user_id text,project_id text,parent_session_id text,task_state text,turn_status text,updated_at timestamptz);
	create table api_turn(session_id text,state text);`);
});
beforeEach(async () => {
	await db.exec(`truncate agent_session,api_turn;
	insert into agent_session values('builder','alice','project',null,null,'running',now());
	insert into agent_session values('subagent','alice','project','builder','draft','idle',now());`);
});
afterAll(async () => {
	await db.close();
});

const state = async (id: string) =>
	(
		await db.query<{ task_state: string; turn_status: string }>(
			"select task_state,turn_status from agent_session where id=$1",
			[id],
		)
	).rows[0];

it("marks an opened subagent working once, so a second start fails", async () => {
	await reserveAgentTaskStart("alice", "project", "subagent");
	expect(await state("subagent")).toEqual({
		task_state: "working",
		turn_status: "running",
	});
	await expect(
		reserveAgentTaskStart("alice", "project", "subagent"),
	).rejects.toThrow("already running");
});

it("never starts a root chat, another owner's row or one with a queued turn", async () => {
	await expect(
		reserveAgentTaskStart("alice", "project", "builder"),
	).rejects.toThrow();
	await expect(
		reserveAgentTaskStart("bob", "project", "subagent"),
	).rejects.toThrow();
	await db.exec("insert into api_turn values('subagent','queued')");
	await expect(
		reserveAgentTaskStart("alice", "project", "subagent"),
	).rejects.toThrow();
	expect((await state("subagent")).task_state).toBe("draft");
});

it("validates the model concurrency limits", () => {
	vi.stubEnv("YTIMESY_MODEL_CONCURRENCY", "1");
	expect(() => modelConcurrencyLimits()).toThrow("between 2 and 32");
	vi.unstubAllEnvs();
	expect(modelConcurrencyLimits()).toMatchObject({ worker: 4 });
});
