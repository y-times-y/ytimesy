import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { FreestyleApiError } from "freestyle";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { releaseReplacedTemplateSnapshots } from "../src/server/adapters/freestyle/template-snapshot-release";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
		"20260927210000_project_environments.sql",
		"20261013101000_environment_build_release.sql",
		"20261103230000_environment_build_snapshot_release.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(`alter table workspace add column template_snapshot_id text;
		create table workspace_retention(session_id uuid primary key, snapshot_id text);
		create table product_setting(key text primary key, value text);
		insert into auth_user(id,name,email,"emailVerified") values ('alice','Alice','alice@test.invalid',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('11111111-1111-4111-8111-111111111111','alice',1,1,'org/web','main');
		insert into workspace(id,user_id,project_id,status,template_snapshot_id) values('${workspaceId}','alice','11111111-1111-4111-8111-111111111111','ready','sh-current');`);
	const build = (id: string, snapshot: string, vm: string, age: string) =>
		db.query(
			`insert into environment_build(id,workspace_id,status,input_hash,sources,snapshot_id,provider_ref,created_at,completed_at)
			 values($1,$2,'ready','h','[]',$3,$4,now()-$5::interval,now()-$5::interval)`,
			[id, workspaceId, snapshot, vm, age],
		);
	await build(
		"00000000-0000-4000-8000-000000000001",
		"sh-old",
		"vm-old",
		"3 days",
	);
	await build(
		"00000000-0000-4000-8000-000000000002",
		"sh-recycled",
		"vm-recycled",
		"3 days",
	);
	await build(
		"00000000-0000-4000-8000-000000000003",
		"sh-other-vm",
		"vm-mine",
		"3 days",
	);
	await build(
		"00000000-0000-4000-8000-000000000004",
		"sh-current",
		"vm-current",
		"2 days",
	);
	await db.exec(
		"insert into workspace_retention(session_id,snapshot_id) values('33333333-3333-4333-8333-333333333333','sh-recycled')",
	);
});
afterAll(() => db.close());

function fakeClient(sources: Record<string, string>) {
	const deleted: string[] = [];
	return {
		deleted,
		client: {
			vms: {
				snapshots: {
					get: async (id: string) => {
						if (!(id in sources))
							throw new FreestyleApiError(
								404,
								{ code: "NOT_FOUND", message: "gone" },
								"/",
							);
						return { id, public: false, sourceVmId: sources[id] };
					},
					delete: async (id: string) => {
						deleted.push(id);
					},
				},
			},
		} as never,
	};
}

it("deletes only replaced, unreferenced snapshots its own build machine made, once", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const fake = fakeClient({
		"sh-old": "vm-old",
		"sh-recycled": "vm-recycled",
		"sh-other-vm": "vm-someone-else",
		"sh-current": "vm-current",
	});
	expect(await releaseReplacedTemplateSnapshots(fake.client)).toBe(2);
	// The current template and a recycled chat's snapshot stay; a snapshot of
	// another machine is never deleted.
	expect(fake.deleted).toEqual(["sh-old"]);
	expect(await releaseReplacedTemplateSnapshots(fake.client)).toBe(0);
	const rows = await db.query<{ snapshot_id: string }>(
		"select snapshot_id from environment_build where snapshot_released_at is not null order by snapshot_id",
	);
	// The rows keep their snapshot ids for checkout-commit lookups.
	expect(rows.rows.map((r) => r.snapshot_id)).toEqual([
		"sh-old",
		"sh-other-vm",
	]);
});

it("keeps a template replaced less than a day ago", async () => {
	await db.query(
		`insert into environment_build(id,workspace_id,status,input_hash,sources,snapshot_id,provider_ref,created_at,completed_at)
		 values('00000000-0000-4000-8000-000000000005',$1,'ready','h','[]','sh-newest','vm-newest',now(),now())`,
		[workspaceId],
	);
	await db.query(
		"update workspace set template_snapshot_id='sh-newest' where id=$1",
		[workspaceId],
	);
	const fake = fakeClient({ "sh-current": "vm-current" });
	expect(await releaseReplacedTemplateSnapshots(fake.client)).toBe(0);
	expect(fake.deleted).toEqual([]);
});
