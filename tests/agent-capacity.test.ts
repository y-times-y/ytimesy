import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	agentCapacity,
	modelConcurrencyLimits,
	reserveAgentTaskStart,
} from "../src/server/adapters/agent-capacity";

let db: PGlite;
const query = async (sql: string, values: unknown[] = []) => {
	const result = await db.query(sql, values);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id text primary key,user_id text,project_id text,parent_session_id text,task_state text,turn_status text,updated_at timestamptz);
	create table api_turn(session_id text,state text);`);
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_MODEL_CONCURRENCY", "4");
	vi.stubEnv("YTIMESY_USER_TURN_CONCURRENCY", "8");
	vi.stubEnv("YTIMESY_FLEET_TURN_CONCURRENCY", "4");
	vi.stubEnv("YTIMESY_TASK_CHILD_CONCURRENCY", "3");
	await db.exec(`truncate agent_session,api_turn;
	insert into agent_session values('leader','alice','project',null,null,'running',now());
	insert into agent_session select 'child-'||i,'alice','project','leader','draft','idle',now() from generate_series(1,6) i;`);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await db.close();
});

it("admits three children, rejects the fourth without marking it working, and releases settled capacity", async () => {
	for (let i = 1; i <= 3; i++)
		await reserveAgentTaskStart("alice", "project", `child-${i}`);
	expect((await agentCapacity("alice")).available).toBe(0);
	await expect(
		reserveAgentTaskStart("alice", "project", "child-4"),
	).rejects.toThrow("capacity is full");
	expect(
		(await query("select task_state from agent_session where id='child-4'"))
			.rows,
	).toEqual([{ task_state: "draft" }]);
	await query(
		"update agent_session set task_state='done',turn_status='completed' where id='child-1'",
	);
	await reserveAgentTaskStart("alice", "project", "child-4");
});

it("counts queued children once and preserves a leader slot when the leader is idle", async () => {
	await query("update agent_session set turn_status='idle' where id='leader'");
	await reserveAgentTaskStart("alice", "project", "child-1");
	await query("insert into api_turn values('child-1','queued')");
	expect((await agentCapacity("alice")).available).toBe(2);
});

it("enforces ownership, draft compare-and-set, and account limits", async () => {
	await expect(
		reserveAgentTaskStart("bob", "project", "child-1"),
	).rejects.toThrow();
	vi.stubEnv("YTIMESY_USER_TURN_CONCURRENCY", "2");
	await reserveAgentTaskStart("alice", "project", "child-1");
	await expect(
		reserveAgentTaskStart("alice", "project", "child-1"),
	).rejects.toThrow();
	await expect(
		reserveAgentTaskStart("alice", "project", "child-2"),
	).rejects.toThrow();
});

it("includes other conversations in available worker capacity", async () => {
	await query(
		"insert into agent_session values('other','bob','other',null,null,'running',now())",
	);
	expect((await agentCapacity("alice")).available).toBe(2);
});

it("defaults to edge fleet capacity rather than one worker's slots", () => {
	for (const name of [
		"YTIMESY_MODEL_CONCURRENCY",
		"YTIMESY_USER_TURN_CONCURRENCY",
		"YTIMESY_FLEET_TURN_CONCURRENCY",
		"YTIMESY_TASK_CHILD_CONCURRENCY",
	])
		vi.stubEnv(name, undefined);
	expect(modelConcurrencyLimits()).toEqual({
		worker: 4,
		fleet: 256,
		perUser: 32,
		maxChildren: 8,
	});
});

it("rejects invalid capacity instead of silently disabling the limit", () => {
	vi.stubEnv("YTIMESY_MODEL_CONCURRENCY", "NaN");
	expect(modelConcurrencyLimits).toThrow();
});

it("uses fleet capacity independently of each worker but bounds each parent's fan-out", async () => {
	vi.stubEnv("YTIMESY_FLEET_TURN_CONCURRENCY", "16");
	expect((await agentCapacity("alice")).available).toBe(7);
	for (let i = 1; i <= 3; i++)
		await reserveAgentTaskStart("alice", "project", `child-${i}`);
	await expect(
		reserveAgentTaskStart("alice", "project", "child-4"),
	).rejects.toThrow();
	await query(
		"insert into agent_session values('second-leader','alice','project',null,null,'running',now()),('second-child','alice','project','second-leader','draft','idle',now())",
	);
	await reserveAgentTaskStart("alice", "project", "second-child");
});

it.each(["0", "NaN", "10001"])("rejects invalid fleet capacity %s", (value) => {
	vi.stubEnv("YTIMESY_FLEET_TURN_CONCURRENCY", value);
	expect(modelConcurrencyLimits).toThrow();
});
