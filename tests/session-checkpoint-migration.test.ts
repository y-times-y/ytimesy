import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds private checkpoint metadata without changing chats and cascades only metadata on deletion", async () => {
	const db = new PGlite();
	try {
		await db.exec(
			"create role anon; create role authenticated; create table agent_session(id uuid primary key); insert into agent_session values ('00000000-0000-4000-8000-000000000001')",
		);
		await db.exec(
			await readFile(
				"supabase/migrations/20260930130000_session_checkpoints.sql",
				"utf8",
			),
		);
		expect((await db.query("select * from agent_session")).rows).toHaveLength(
			1,
		);
		await db.exec(
			"insert into session_checkpoint(session_id,user_id,object_path,turn_fingerprint,executor_id) values ('00000000-0000-4000-8000-000000000001','alice','private','hash','vm')",
		);
		await db.exec("delete from agent_session");
		expect(
			(await db.query("select * from session_checkpoint")).rows,
		).toHaveLength(0);
		expect(
			(
				await db.query(
					"select relrowsecurity from pg_class where relname='session_checkpoint'",
				)
			).rows[0],
		).toMatchObject({ relrowsecurity: true });
	} finally {
		await db.close();
	}
});
