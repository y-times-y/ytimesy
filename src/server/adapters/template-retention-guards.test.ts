import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerRefsHeldOutside } from "./agent-sessions";
import { staleBuildMachineIds } from "./freestyle/storage-retention";
import { releaseReplacedTemplateSnapshots } from "./freestyle/template-snapshot-release";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
	 create table agent_session(id uuid primary key default gen_random_uuid(), user_id text, provider_ref text);
	 create table workspace(id uuid primary key default gen_random_uuid(), user_id text, provider_ref text, template_snapshot_id text);
	 create table environment_build(id uuid primary key default gen_random_uuid(), workspace_id uuid, status text, snapshot_id text, provider_ref text,
	   created_at timestamptz default now(), completed_at timestamptz, provider_released_at timestamptz, snapshot_released_at timestamptz);
	 create table workspace_retention(snapshot_id text, vm_id text, phase text);
	 create table product_setting(value text);`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function project(templateVm: string, snapshot: string) {
	const { rows } = await db.query<{ id: string }>(
		"insert into workspace(user_id,provider_ref,template_snapshot_id) values('alice',$1,$2) returning id",
		[templateVm, snapshot],
	);
	return rows[0]?.id as string;
}

it("archiving a chat never releases its project's template VM or its ready build VM", async () => {
	const workspaceId = await project("vm-template", "sh-current");
	await db.query(
		"insert into environment_build(workspace_id,status,snapshot_id,provider_ref,completed_at) values($1,'ready','sh-current','vm-build',now())",
		[workspaceId],
	);
	const chat = "11111111-1111-1111-1111-111111111111";
	await db.query(
		"insert into agent_session(id,user_id,provider_ref) values($1,'alice','vm-template')",
		[chat],
	);
	const held = await providerRefsHeldOutside("alice", [chat]);
	expect(held.has("vm-template")).toBe(true);
	expect(held.has("vm-build")).toBe(true);
	expect((await providerRefsHeldOutside("bob", [chat])).size).toBe(0);
});

it("the stale-build sweep never names the template VM, even if its own build failed long ago", async () => {
	const workspaceId = await project("vm-template", "sh-current");
	await db.query(
		`insert into environment_build(workspace_id,status,provider_ref,created_at) values
		 ($1,'failed','vm-template',now()-interval '3 days'),
		 ($1,'failed','vm-old-builder',now()-interval '3 days')`,
		[workspaceId],
	);
	expect(await staleBuildMachineIds()).toEqual(["vm-old-builder"]);
});

it("a replaced-snapshot release never deletes the workspace's current template snapshot", async () => {
	const workspaceId = await project("vm-template", "sh-current");
	await db.query(
		`insert into environment_build(workspace_id,status,snapshot_id,provider_ref,completed_at) values
		 ($1,'ready','sh-current','vm-template',now()-interval '5 days'),
		 ($1,'ready','sh-older','vm-older',now()-interval '9 days'),
		 ($1,'ready','sh-newest','vm-newest',now()-interval '3 days')`,
		[workspaceId],
	);
	const deleted: string[] = [];
	const client = {
		vms: {
			snapshots: {
				get: async (id: string) => ({
					public: false,
					sourceVmId: id === "sh-older" ? "vm-older" : "vm-template",
				}),
				delete: async (id: string) => {
					deleted.push(id);
				},
			},
		},
	};
	await releaseReplacedTemplateSnapshots(client as never);
	expect(deleted).toEqual(["sh-older"]);
	expect(deleted).not.toContain("sh-current");
});
