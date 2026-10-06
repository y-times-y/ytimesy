import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves existing turns and enforces private bounded repair and idempotent wakeups", async () => {
	const db = new PGlite();
	const session = "00000000-0000-4000-8000-000000000001";
	try {
		await db.exec(
			`create role anon; create role authenticated; create table agent_session(id uuid primary key); create table api_turn(id uuid primary key,session_id uuid not null references agent_session(id)); insert into agent_session values('${session}'); insert into api_turn values('00000000-0000-4000-8000-000000000002','${session}');`,
		);
		await db.exec(
			await readFile(
				"supabase/migrations/20261005160000_agent_pr_repair.sql",
				"utf8",
			),
		);
		expect((await db.query("select * from api_turn")).rows).toHaveLength(1);
		await db.exec(
			`insert into agent_pr_repair_control(session_id,attempts) values('${session}',3);`,
		);
		await expect(
			db.exec("update agent_pr_repair_control set attempts=4"),
		).rejects.toThrow();
		await db.exec(`update api_turn set idempotency_key='repair-id';`);
		await expect(
			db.exec(
				`insert into api_turn values('00000000-0000-4000-8000-000000000003','${session}','repair-id')`,
			),
		).rejects.toThrow();
		expect(
			(
				await db.query(
					"select relrowsecurity from pg_class where relname='agent_pr_repair_event'",
				)
			).rows[0],
		).toMatchObject({ relrowsecurity: true });
		await db.exec("set role anon");
		await expect(
			db.query("select * from agent_pr_repair_event"),
		).rejects.toThrow();
		await db.exec("reset role");
	} finally {
		await db.close();
	}
});
