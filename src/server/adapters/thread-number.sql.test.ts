import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";

/**
 * supabase/migrations/20261118120000_thread_number.sql: readable thread
 * numbers per project, assigned by a trigger and never reused.
 */
let db: PGlite;
const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const id = (n: number) =>
	`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function insert(
	n: number,
	project: string,
	extra: { created?: string; parent?: number; role?: string } = {},
) {
	await db.query(
		`insert into agent_session(id,project_id,parent_session_id,chat_role,created_at)
		 values ($1,$2,$3,$4,$5)`,
		[
			id(n),
			project,
			extra.parent ? id(extra.parent) : null,
			extra.role ?? null,
			extra.created ?? "2026-11-01T00:00:00Z",
		],
	);
}

const numbers = async () =>
	Object.fromEntries(
		(
			await db.query<{ id: string; thread_number: number | null }>(
				"select id,thread_number from agent_session",
			)
		).rows.map((row) => [row.id, row.thread_number]),
	);

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table project(id uuid primary key);
	 create table agent_session(id uuid primary key, project_id uuid not null,
	  parent_session_id uuid, chat_role text, archived_at timestamptz,
	  created_at timestamptz not null default now());
	 insert into project values ('${P1}'),('${P2}');`);
});
afterEach(() => db.close());

const migrate = () =>
	db.exec(
		readFileSync(
			"supabase/migrations/20261118120000_thread_number.sql",
			"utf8",
		),
	);

it("numbers existing threads per project in creation order, skipping Y² and subagents", async () => {
	await insert(1, P1, { created: "2026-11-03T00:00:00Z" });
	await insert(2, P1, { created: "2026-11-01T00:00:00Z" });
	await insert(3, P1, { role: "y2" });
	await insert(4, P1, { parent: 1 });
	await insert(5, P2, { created: "2026-11-02T00:00:00Z" });
	await migrate();
	const all = await numbers();
	expect(all[id(2)]).toBe(1);
	expect(all[id(1)]).toBe(2);
	expect(all[id(3)]).toBeNull();
	expect(all[id(4)]).toBeNull();
	// Each project counts on its own.
	expect(all[id(5)]).toBe(1);
});

it("gives a new thread the project's next number, and subagents and Y² none", async () => {
	await insert(1, P1);
	await insert(2, P1);
	await migrate();
	await insert(3, P1);
	await insert(4, P1, { parent: 3 });
	await insert(5, P1, { role: "y2" });
	await insert(6, P2);
	const all = await numbers();
	expect(all[id(3)]).toBe(3);
	expect(all[id(4)]).toBeNull();
	expect(all[id(5)]).toBeNull();
	expect(all[id(6)]).toBe(1);
});

it("never reuses a number, even after the newest thread is deleted", async () => {
	await insert(1, P1);
	await insert(2, P1);
	await migrate();
	await db.query("delete from agent_session where id=$1", [id(2)]);
	await insert(3, P1);
	expect((await numbers())[id(3)]).toBe(3);
});

it("numbers a project that has no threads yet from 1", async () => {
	await migrate();
	await insert(1, P1);
	expect((await numbers())[id(1)]).toBe(1);
});

it("refuses two threads with the same number in one project", async () => {
	await insert(1, P1);
	await migrate();
	await expect(
		db.query("update agent_session set thread_number=1 where id=$1", [id(1)]),
	).resolves.toBeDefined();
	await db.query(
		"insert into agent_session(id,project_id,thread_number) values ($1,$2,7)",
		[id(8), P1],
	);
	await expect(
		db.query(
			"insert into agent_session(id,project_id,thread_number) values ($1,$2,7)",
			[id(9), P1],
		),
	).rejects.toThrow(/agent_session_thread_number|duplicate/);
});
