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
	 branch text not null, name text, machine_size text, y_enabled boolean not null default false, repository_set_key text not null default '',
	 archived_at timestamptz, created_at timestamptz default now(),
	 unique(user_id,repository_id,repository_set_key));
	 create table project_repository(project_id uuid, repository_id bigint, installation_id bigint,
	 full_name text, branch text, position integer);
	 create table agent_session(id text primary key, user_id text, project_id uuid, chat_role text, archived_at timestamptz);`);
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

it("lists whether each project is a Y project, with the project", async () => {
	await saveProject("u", repo(1, "plain") as never, "main");
	await saveProject("u", repo(2, "yproject") as never, "main");
	await db.query("update project set y_enabled=true where full_name=$1", [
		"me/yproject",
	]);
	const listed = await listProjects("u");
	expect(
		Object.fromEntries(listed.map((p) => [p.fullName, p.yEnabled])),
	).toEqual({ "me/plain": false, "me/yproject": true });
});

it("lists a Y project's Super agent chat id with the project, and none for others", async () => {
	const plain = await saveProject("u", repo(1, "plain") as never, "main");
	const y = await saveProject("u", repo(2, "yproject") as never, "main");
	await db.query("update project set y_enabled=true where id=$1", [y.id]);
	await db.query(
		`insert into agent_session(id,user_id,project_id,chat_role) values
		 ('super-1','u',$1,'y2'),('thread-1','u',$1,null),('old-super','u',$1,'y2'),('other-1','u',$2,'y2')`,
		[y.id, plain.id],
	);
	await db.query(
		"update agent_session set archived_at=now() where id='old-super'",
	);
	const byName = Object.fromEntries(
		(await listProjects("u")).map((p) => [p.fullName, p.ySquaredId]),
	);
	// The live Super agent chat of the Y project; not an archived one, not a thread.
	expect(byName["me/yproject"]).toBe("super-1");
	// A plain project has none, even if a stray y2 row exists for it.
	expect(byName["me/plain"] ?? null).toBeNull();
});
