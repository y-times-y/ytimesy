import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const RETIRE = "20261019190000_retire_lead_child_tasks.sql";

it("deletes role-less child rows and their subtrees, keeps chats and subagents, and drops retired schema", async () => {
	const db = new PGlite();
	try {
		await db.exec("create role anon; create role authenticated;");
		const files = (await readdir("supabase/migrations")).sort();
		for (const file of files.filter((file) => file < RETIRE))
			await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
		await db.exec(`
			insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true);
			insert into project(id,user_id,repository_id,installation_id,full_name,branch)
			values('00000000-0000-4000-8000-0000000000a1','alice',1,1,'alice/app','main');
			insert into workspace(id,user_id,project_id,status)
			values('00000000-0000-4000-8000-0000000000b1','alice','00000000-0000-4000-8000-0000000000a1','ready');
		`);
		const ids = {
			chat: "00000000-0000-4000-8000-000000000001",
			reader: "00000000-0000-4000-8000-000000000002",
			legacy: "00000000-0000-4000-8000-000000000003",
			underLegacy: "00000000-0000-4000-8000-000000000004",
		};
		const insert = (id: string, parent: string | null, role: string | null) =>
			db.query(
				`insert into agent_session(id,user_id,project_id,workspace_id,harness,parent_session_id,title,agent_role,status)
				values($1,'alice','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','api',$2,'t',$3,'ready')`,
				[id, parent, role],
			);
		await insert(ids.chat, null, null);
		await insert(ids.reader, ids.chat, "researcher");
		await insert(ids.legacy, ids.chat, null);
		await insert(ids.underLegacy, ids.legacy, "writer");
		await db.exec(await readFile(`supabase/migrations/${RETIRE}`, "utf8"));
		expect(
			(
				await db.query<{ id: string }>(
					"select id from agent_session order by id",
				)
			).rows.map((row) => row.id),
		).toEqual([ids.chat, ids.reader]);
		const columns = (
			await db.query<{ column_name: string }>(
				"select column_name from information_schema.columns where table_name='agent_session'",
			)
		).rows.map((row) => row.column_name);
		for (const gone of [
			"depends_on_session_id",
			"task_execution",
			"task_pull_request_url",
			"candidate_index",
			"competition_id",
		])
			expect(columns).not.toContain(gone);
		for (const kept of [
			"task_prompt",
			"task_state",
			"task_summary",
			"task_placement",
			"task_access",
			"task_review_state",
			"task_branch",
			"agent_role",
		])
			expect(columns).toContain(kept);
		const tables = (
			await db.query<{ table_name: string }>(
				"select table_name from information_schema.tables where table_schema='public'",
			)
		).rows.map((row) => row.table_name);
		for (const gone of [
			"agent_competition",
			"fusion_sidekick",
			"agent_pr_repair_event",
			"agent_pr_repair_control",
		])
			expect(tables).not.toContain(gone);
	} finally {
		await db.close();
	}
});
