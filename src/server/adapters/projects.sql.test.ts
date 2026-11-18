import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listProjects, saveProject } from "./projects";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table project(id uuid primary key, user_id text not null,
	 repository_id bigint not null, installation_id bigint not null, full_name text not null,
	 branch text not null, name text, machine_size text, repository_set_key text not null default '',
	 archived_at timestamptz, created_at timestamptz default now(),
	 unique(user_id,repository_id,repository_set_key));
	 create table project_repository(project_id uuid, repository_id bigint, installation_id bigint,
	 full_name text, branch text, position integer);`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const repo = (id: number, name: string) => ({
	repositoryId: id,
	installationId: 1,
	fullName: `me/${name}`,
	defaultBranch: "main",
});

it("adds a repository as a new project that the list shows", async () => {
	const saved = await saveProject("u", repo(10, "web") as never, "main");
	expect((await listProjects("u")).map((project) => project.id)).toEqual([
		saved.id,
	]);
});

it("restores a removed (archived) project when its repository is added again, so it is listed and can be selected", async () => {
	const first = await saveProject("u", repo(10, "agent-hop") as never, "main");
	await saveProject("u", repo(11, "other") as never, "main");
	await db.query("update project set archived_at=now() where id=$1", [
		first.id,
	]);
	expect((await listProjects("u")).map((p) => p.fullName)).toEqual([
		"me/other",
	]);
	const again = await saveProject("u", repo(10, "agent-hop") as never, "main");
	expect(again.id).toBe(first.id);
	expect((await listProjects("u")).map((p) => p.id)).toContain(again.id);
});

it("does not touch another user's project with the same repository", async () => {
	const mine = await saveProject("u", repo(10, "web") as never, "main");
	await db.query("update project set archived_at=now() where id=$1", [mine.id]);
	await saveProject("other", repo(10, "web") as never, "main");
	expect(await listProjects("u")).toEqual([]);
	void randomUUID;
});

it("lists each project's machine size for the thread hover card", async () => {
	const saved = await saveProject("u", repo(10, "web") as never, "main");
	await db.query("update project set machine_size='small' where id=$1", [
		saved.id,
	]);
	expect((await listProjects("u"))[0]?.machineSize).toBe("small");
});
