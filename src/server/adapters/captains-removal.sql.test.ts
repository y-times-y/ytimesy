import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	// The schema the removal starts from: captains applied on top of the canary roles.
	await db.exec(`create role anon; create role authenticated;
	create table auth_user(id text primary key);
	create table project(id uuid primary key, user_id text not null references auth_user(id), y_enabled boolean not null default true);
	create table agent_session(id uuid primary key, user_id text, project_id uuid, harness text not null default 'api', title text not null default 't', status text not null default 'idle',
	 chat_role text check (chat_role in ('y2','canary')), parent_session_id uuid,
	 constraint agent_session_y2_is_root check (chat_role is null or parent_session_id is null));
	create table api_turn(id uuid primary key default gen_random_uuid(), session_id uuid);
	insert into auth_user values ('alice');
	insert into project(id,user_id) values ('00000000-0000-4000-8000-000000000001','alice');`);
	await db.exec(
		readFileSync("supabase/migrations/20261126130000_captains.sql", "utf8"),
	);
});
afterEach(() => db.close());

it("drops the table and column, deletes captain chats and their turns, keeps every other chat", async () => {
	await db.exec(`insert into agent_session(id,user_id,project_id,chat_role) values
	 ('00000000-0000-4000-8000-0000000000a1','alice','00000000-0000-4000-8000-000000000001','y2'),
	 ('00000000-0000-4000-8000-0000000000a2','alice','00000000-0000-4000-8000-000000000001','captain'),
	 ('00000000-0000-4000-8000-0000000000a3','alice','00000000-0000-4000-8000-000000000001',null),
	 ('00000000-0000-4000-8000-0000000000a4','alice','00000000-0000-4000-8000-000000000001','canary');
	 insert into captain(user_id,project_id,chat_id,name,color) values ('alice','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','seo','#d97757');
	 insert into api_turn(session_id) values ('00000000-0000-4000-8000-0000000000a2'),('00000000-0000-4000-8000-0000000000a3');
	 update project set leader_name='otto';`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261126140000_drop_captains.sql",
			"utf8",
		),
	);
	const chats = await db.query<{ id: string }>(
		"select id from agent_session order by id",
	);
	expect(chats.rows.map((r) => r.id.slice(-2))).toEqual(["a1", "a3", "a4"]);
	expect((await db.query("select * from api_turn")).rows).toHaveLength(1);
	await expect(db.query("select * from captain")).rejects.toThrow();
	await expect(db.query("select leader_name from project")).rejects.toThrow();
	await expect(
		db.query(
			"insert into agent_session(id,user_id,project_id,chat_role) values (gen_random_uuid(),'alice','00000000-0000-4000-8000-000000000001','captain')",
		),
	).rejects.toThrow();
});

it("is safe to run on a database that never had captains", async () => {
	await db.exec(
		readFileSync(
			"supabase/migrations/20261126140000_drop_captains.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261126140000_drop_captains.sql",
			"utf8",
		),
	);
});
