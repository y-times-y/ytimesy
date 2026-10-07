import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { reserveAgentTaskStart } from "../src/server/adapters/agent-capacity";
import type { AgentSessionRecord } from "../src/server/adapters/agent-sessions";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("../src/server/adapters/database", () => ({ database: () => holder }));

it("atomically binds the declared prompt, model, access and predecessor before reserving capacity", async () => {
	const db = new PGlite();
	try {
		await db.exec(
			`create table agent_session(id text primary key,user_id text,project_id text,parent_session_id text,task_state text,turn_status text,updated_at timestamptz,task_prompt text,listed_model_id text,harness text,task_placement text,task_access text,task_execution text,depends_on_session_id text,selected_branch text,base_branch text);create table api_turn(session_id text,state text);`,
		);
		await db.query(
			"insert into agent_session(id,user_id,project_id,parent_session_id,task_state,turn_status,task_prompt,listed_model_id,harness,task_placement,task_access,task_execution) values('task','alice','project','lead','draft','idle','approved prompt','approved model','api','fresh','read_write','parallel')",
		);
		holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
			const result = await db.query(sql, values);
			return { ...result, rowCount: result.affectedRows || result.rows.length };
		});
		holder.connect.mockResolvedValue({ query: holder.query, release() {} });
		const draft = {
			parentSessionId: "lead",
			taskPrompt: "approved prompt",
			listedModelId: "approved model",
			harness: "api",
			taskPlacement: "fresh",
			taskAccess: "read_write",
			taskExecution: "parallel",
			dependsOnSessionId: null,
			selectedBranch: null,
			baseBranch: null,
		} as AgentSessionRecord;
		for (const [column, change, original] of [
			["task_prompt", "changed prompt", "approved prompt"],
			["listed_model_id", "changed model", "approved model"],
			["task_access", "read_only", "read_write"],
			["depends_on_session_id", "changed predecessor", null],
		]) {
			await db.query(`update agent_session set ${column}=$1 where id='task'`, [
				change,
			]);
			await expect(
				reserveAgentTaskStart("alice", "project", "task", draft),
			).rejects.toThrow("draft changed");
			expect(
				(await db.query("select task_state from agent_session where id='task'"))
					.rows,
			).toEqual([{ task_state: "draft" }]);
			await db.query(`update agent_session set ${column}=$1 where id='task'`, [
				original,
			]);
		}
		await reserveAgentTaskStart("alice", "project", "task", draft);
		expect(
			(await db.query("select task_state from agent_session where id='task'"))
				.rows,
		).toEqual([{ task_state: "working" }]);
	} finally {
		await db.close();
	}
});
