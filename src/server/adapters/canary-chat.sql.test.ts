import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NOT_CANARY_CHAT } from "./canary-chat";

/** supabase/migrations/20261126120000_canary_chat_role.sql and the filter every list uses. */
let db: PGlite;
const P = "00000000-0000-4000-8000-0000000000a1";
const id = (n: number) =>
	`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key, project_id uuid not null,
	  parent_session_id uuid, chat_role text check (chat_role = 'y2'), thread_number integer,
	  archived_at timestamptz);
	 create table canary_run(session_id text);
	 insert into agent_session(id,project_id,thread_number) values
	  ('${id(1)}','${P}',1), ('${id(2)}','${P}',2), ('${id(3)}','${P}',3);
	 insert into agent_session(id,project_id,chat_role) values ('${id(4)}','${P}','y2');
	 insert into canary_run values ('${id(2)}'), ('${id(2)}'), (null);`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261126120000_canary_chat_role.sql",
			"utf8",
		),
	);
});
afterEach(() => db.close());

const listed = async () =>
	(
		await db.query<{ id: string }>(
			`select s.id from agent_session s where s.project_id=$1 and ${NOT_CANARY_CHAT} order by s.id`,
			[P],
		)
	).rows.map((row) => row.id);

it("marks only the chats the canary used, and unnumbers them", async () => {
	const rows = await db.query<{
		id: string;
		chat_role: string | null;
		thread_number: number | null;
	}>("select id,chat_role,thread_number from agent_session order by id");
	expect(rows.rows.map((r) => r.chat_role)).toEqual([
		null,
		"canary",
		null,
		"y2",
	]);
	expect(rows.rows[1]?.thread_number).toBeNull();
	expect(rows.rows[0]?.thread_number).toBe(1);
});

it("hides the canary chat from the list filter but keeps the owner's chats", async () => {
	expect(await listed()).toEqual([id(1), id(3), id(4)]);
});

it("accepts the canary role and still rejects unknown ones", async () => {
	await db.query("update agent_session set chat_role='canary' where id=$1", [
		id(3),
	]);
	await expect(
		db.query("update agent_session set chat_role='other' where id=$1", [id(1)]),
	).rejects.toThrow();
	expect(await listed()).toEqual([id(1), id(4)]);
});
