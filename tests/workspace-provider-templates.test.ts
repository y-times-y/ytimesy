import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("provider project template migration", () => {
	it("keeps one private template per workspace and provider", async () => {
		const db = new PGlite();
		try {
			await db.exec("create role anon; create role authenticated");
			await db.exec("create table workspace(id uuid primary key)");
			await db.exec(
				await readFile(
					"supabase/migrations/20260923011000_workspace_provider_templates.sql",
					"utf8",
				),
			);
			const workspace = "00000000-0000-4000-8000-000000000001";
			await db.query("insert into workspace(id) values($1)", [workspace]);
			await db.query(
				`insert into workspace_provider_template(
				 workspace_id,provider,auth_snapshot_id,project_snapshot_id,status
				 ) values($1,'codex','auth-1','project-1','preparing')`,
				[workspace],
			);
			await db.exec(
				await readFile(
					"supabase/migrations/20260923012000_provider_template_auth_fingerprint.sql",
					"utf8",
				),
			);
			const fingerprint = await db.query(
				"select auth_snapshot_fingerprint from workspace_provider_template where provider='codex'",
			);
			expect(fingerprint.rows).toEqual([
				{ auth_snapshot_fingerprint: "a21c4abd8096f4a50698d281a5edb0cc" },
			]);
			await expect(
				db.query(
					`insert into workspace_provider_template(
					 workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,status
					 ) values($1,'codex','auth-2','project-1','preparing')`,
					[workspace],
				),
			).rejects.toThrow();
			const distinct = await db.query(
				`insert into workspace_provider_template(
				 workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,status
				 ) values($1,'claude','auth-3','project-1','preparing')
				 returning provider`,
				[workspace],
			);
			expect(distinct.rows).toEqual([{ provider: "claude" }]);
		} finally {
			await db.close();
		}
	});
});
