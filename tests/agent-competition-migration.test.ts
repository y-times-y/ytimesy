import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("stores one isolated candidate per numbered leader and constrains selection", async () => {
	const db = new PGlite();
	try {
		await db.exec("create role anon; create role authenticated");
		await db.exec(
			"create table auth_user(id text primary key); create table project(id uuid primary key)",
		);
		await db.exec(
			"create table agent_session(id uuid primary key,user_id text,project_id uuid,parent_session_id uuid,items jsonb not null default '[]',task_state text,task_review_state text)",
		);
		await db.exec(
			await readFile(
				"supabase/migrations/20260927220000_agent_competitions.sql",
				"utf8",
			),
		);
		await db.exec(
			"insert into auth_user values('alice'); insert into project values('00000000-0000-4000-8000-000000000001')",
		);
		await db.exec(
			"insert into agent_session(id,user_id,project_id) values('00000000-0000-4000-8000-000000000002','alice','00000000-0000-4000-8000-000000000001')",
		);
		await db.exec(
			"insert into agent_competition(root_session_id,user_id,project_id,prompt,harness,model_id,leader_count) values('00000000-0000-4000-8000-000000000002','alice','00000000-0000-4000-8000-000000000001','Task','api','test',2)",
		);
		await db.exec(
			"insert into agent_session(id,user_id,project_id,parent_session_id,candidate_index) values('00000000-0000-4000-8000-000000000003','alice','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1)",
		);
		await db.exec(
			await readFile(
				"supabase/migrations/20260927233000_agent_competitions_per_turn.sql",
				"utf8",
			),
		);
		const first = await db.query<{ id: string }>(
			"select id from agent_competition",
		);
		await db.exec("update agent_competition set status='complete'");
		await db.exec(
			"insert into agent_competition(root_session_id,user_id,project_id,user_message_id,prompt,harness,model_id,leader_count) values('00000000-0000-4000-8000-000000000002','alice','00000000-0000-4000-8000-000000000001','follow-up','Next','api','test',2)",
		);
		const second = await db.query<{ id: string }>(
			"select id from agent_competition where user_message_id='follow-up'",
		);
		await db.query(
			"insert into agent_session(id,user_id,project_id,parent_session_id,competition_id,candidate_index) values('00000000-0000-4000-8000-000000000004','alice','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$1,1)",
			[second.rows[0].id],
		);
		await expect(
			db.query(
				"insert into agent_session(id,user_id,project_id,parent_session_id,competition_id,candidate_index) values('00000000-0000-4000-8000-000000000006','alice','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$1,1)",
				[second.rows[0].id],
			),
		).rejects.toThrow();
		await expect(
			db.query(
				"insert into agent_session(id,user_id,project_id,parent_session_id,competition_id,candidate_index) values('00000000-0000-4000-8000-000000000005','alice','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$1,6)",
				[first.rows[0].id],
			),
		).rejects.toThrow();
	} finally {
		await db.close();
	}
}, 15_000);
