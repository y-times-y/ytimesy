import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("task command receipts migration", () => {
	it("allows one request receipt per parent and rejects an empty completed response", async () => {
		const db = new PGlite();
		try {
			await db.exec("create role anon; create role authenticated");
			await db.exec("create table agent_session(id uuid primary key)");
			await db.exec(
				await readFile(
					"supabase/migrations/20260923010000_agent_task_command_receipts.sql",
					"utf8",
				),
			);
			await db.exec(
				await readFile(
					"supabase/migrations/20260923013000_agent_task_command_heartbeat.sql",
					"utf8",
				),
			);
			const parent = "00000000-0000-4000-8000-000000000001";
			await db.query("insert into agent_session(id) values($1)", [parent]);
			await db.query(
				"insert into agent_task_command_receipt(parent_session_id,request_id,status) values($1,$2,'processing')",
				[parent, "request-1"],
			);
			const duplicate = await db.query(
				"insert into agent_task_command_receipt(parent_session_id,request_id,status) values($1,$2,'processing') on conflict do nothing returning request_id",
				[parent, "request-1"],
			);
			expect(duplicate.rows).toEqual([]);
			await expect(
				db.query(
					"update agent_task_command_receipt set status='done' where parent_session_id=$1 and request_id=$2",
					[parent, "request-1"],
				),
			).rejects.toThrow();
		} finally {
			await db.close();
		}
	}, 15_000);
});
