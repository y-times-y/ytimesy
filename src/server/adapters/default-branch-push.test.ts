import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	defaultBranchPushSetting,
	projectAllowsDefaultBranchPush,
	setDefaultBranchPushSetting,
} from "./default-branch-push";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

const project = "5b3c9a40-0b5e-4d3a-9a51-2f7d6f1e8c11";
let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(
		`create table project(id uuid primary key, user_id text not null);
		 insert into project values ('${project}', 'alice');
		 alter table project add column allow_default_branch_push boolean not null default false;`,
	);
	holder.query.mockImplementation((sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
});
afterEach(() => db.close());

it("is off by default, and only the owner reads or changes it", async () => {
	expect(await projectAllowsDefaultBranchPush("alice", project)).toBe(false);
	await setDefaultBranchPushSetting("alice", project, true);
	expect(await projectAllowsDefaultBranchPush("alice", project)).toBe(true);
	expect(await projectAllowsDefaultBranchPush("bob", project)).toBe(false);
	expect(await defaultBranchPushSetting("bob", project)).toBe(null);
	await expect(
		setDefaultBranchPushSetting("bob", project, false),
	).rejects.toBeInstanceOf(Response);
	expect(await projectAllowsDefaultBranchPush("alice", project)).toBe(true);
});
