import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let db: PGlite;
vi.mock("./database", () => ({
	database: () => ({
		query: async (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../auth/session-cache", () => ({ forgetUserSessions: () => {} }));

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "11111111-2222-3333-4444-555555555556";

beforeAll(async () => {
	db = new PGlite();
	await db.exec(`
		create table workspace_retention(session_id uuid, user_id text, vm_id text, snapshot_id text);
		create table agent_session(id uuid primary key, user_id text, provider_ref text);
		create table workspace(provider_ref text, template_snapshot_id text);
		create table environment_build(provider_ref text, snapshot_id text);
		create table product_setting(value text);
		create table infrastructure_vm_admission(slug text primary key, vm_id text);
		insert into agent_session values('${SESSION}','u','vm-r3'),('${OTHER}','u','vm-other');
		insert into infrastructure_vm_admission values
			('ytimesy-ag-1111111122223333','vm-1'),
			('ytimesy-ag-1111111122223333-r2','vm-r2'),
			('ytimesy-ag-1111111122223333-r3','vm-r3'),
			('ytimesy-ag-ffffffffffffffff-r2','vm-stranger');
	`);
});
afterAll(() => db.close());

it("names every generation's VM of a deleted chat, and no other chat's", async () => {
	const { chatCleanupTargets } = await import("./account-deletion");
	const targets = await chatCleanupTargets("u", [SESSION]);
	expect(targets.vmIds).toEqual(["vm-1", "vm-r2", "vm-r3"]);
});
