import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Y_SQUARED_WELCOME } from "#/domain/y-default";
import { saveProject, saveProjectGroup } from "./projects";
import { ySquaredBackfill } from "./y-backfill";
import {
	consumeUserWake,
	ensureYSquaredChat,
	readUserYDefault,
	setProjectYMode,
	setUserYDefault,
} from "./y-mode";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const migration = readFileSync(
	"supabase/migrations/20261124150000_y_default_on.sql",
	"utf8",
);

beforeEach(async () => {
	db = new PGlite();
	// The schema before this migration: y_enabled defaults to false.
	await db.exec(`create role anon; create role authenticated;
	create table auth_user(id text primary key);
	create table project(id uuid primary key, user_id text not null references auth_user(id),
	 repository_id bigint not null, installation_id bigint not null, full_name text not null,
	 branch text not null, name text, machine_size text, y_enabled boolean not null default false, leader_name text,
	 repository_set_key text not null default '', archived_at timestamptz,
	 created_at timestamptz default now(), unique(user_id,repository_id,repository_set_key));
	create table project_repository(project_id uuid, repository_id bigint, installation_id bigint,
	 full_name text, branch text, position integer);
	create table workspace(id uuid primary key, user_id text, project_id uuid unique);
	create table agent_session(id text primary key, user_id text, project_id uuid, workspace_id uuid,
	 harness text not null, title text not null, listed_model_id text, status text not null,
	 chat_role text, parent_session_id text, archived_at timestamptz, items jsonb not null default '[]',
	 updated_at timestamptz not null default now());
	create unique index agent_session_one_y2 on agent_session(user_id, project_id)
	 where chat_role='y2' and archived_at is null;
	insert into auth_user values ('u'),('v');`);
	await db.exec(migration);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const repo = (id: number) =>
	({
		repositoryId: id,
		installationId: 1,
		fullName: `me/r${id}`,
		defaultBranch: "main",
	}) as never;
const addProject = async (userId: string, id: number) => {
	const projectId = randomUUID();
	await db.query(
		"insert into project(id,user_id,repository_id,installation_id,full_name,branch,y_enabled,created_at) values($1,$2,$3,1,'a/b','main',false,timestamptz '2026-10-01 00:00+00')",
		[projectId, userId, id],
	);
	return projectId;
};
const flags = async (projectId: string) =>
	(
		await db.query<{ y_enabled: boolean; y_choice: string | null }>(
			"select y_enabled,y_choice from project where id=$1",
			[projectId],
		)
	).rows[0];

describe("the migration", () => {
	it("is idempotent", async () => {
		await db.exec(migration);
		await db.exec(migration);
	});
});

describe("Y² is on by default", () => {
	it("a project added through either path starts with Y² on and no recorded choice", async () => {
		const group = await saveProjectGroup("u", "app", [
			{
				repositoryId: 1,
				installationId: 1,
				fullName: "me/a",
				branch: "main",
			} as never,
		]);
		const single = await saveProject("u", repo(2), "main");
		expect(await flags(group.id)).toEqual({ y_enabled: true, y_choice: null });
		expect(await flags(single.id)).toEqual({ y_enabled: true, y_choice: null });
	});

	it("a user who turned Y² off for everything gets new projects with Y² off", async () => {
		await setUserYDefault("u", false);
		expect(await readUserYDefault("u")).toBe(false);
		const added = await saveProject("u", repo(3), "main");
		expect(await flags(added.id)).toMatchObject({ y_enabled: false });
		expect(await readUserYDefault("v")).toBe(true);
	});

	it("the user-level switch moves every project of that user and records the choice", async () => {
		const a = await addProject("u", 1);
		const other = await addProject("v", 2);
		await setUserYDefault("u", false);
		expect(await flags(a)).toEqual({ y_enabled: false, y_choice: "off" });
		await setUserYDefault("u", true);
		expect(await flags(a)).toEqual({ y_enabled: true, y_choice: "on" });
		expect(await flags(other)).toEqual({ y_enabled: false, y_choice: null });
	});

	it("the project switch records an explicit choice", async () => {
		const a = await addProject("u", 1);
		await setProjectYMode("u", a, true);
		expect(await flags(a)).toEqual({ y_enabled: true, y_choice: "on" });
		await setProjectYMode("u", a, false);
		expect(await flags(a)).toEqual({ y_enabled: false, y_choice: "off" });
	});
});

describe("the Super agent chat appears when the project is added", () => {
	it("is created beside the project's workspace with no thread yet, with a welcome line, once", async () => {
		const projectId = await addProject("u", 1);
		await db.query("insert into workspace values($1,'u',$2)", [
			randomUUID(),
			projectId,
		]);
		const first = await ensureYSquaredChat("u", projectId);
		const again = await ensureYSquaredChat("u", projectId);
		expect(first).toBeTruthy();
		expect(again).toBe(first);
		const chat = (
			await db.query<{
				items: { kind: string; text: string }[];
				listed_model_id: string | null;
				chat_role: string;
			}>(
				"select items,listed_model_id,chat_role from agent_session where project_id=$1",
				[projectId],
			)
		).rows;
		expect(chat).toHaveLength(1);
		expect(chat[0]?.chat_role).toBe("y2");
		expect(chat[0]?.items[0]).toMatchObject({
			kind: "agentMessage",
			text: Y_SQUARED_WELCOME,
		});
		expect(chat[0]?.listed_model_id).toBeNull();
	});

	it("carries the connected model when one is given", async () => {
		const projectId = await addProject("u", 1);
		await db.query("insert into workspace values($1,'u',$2)", [
			randomUUID(),
			projectId,
		]);
		await ensureYSquaredChat("u", projectId, {
			harnessId: "api",
			modelId: "m1",
		});
		const row = (
			await db.query<{ harness: string; listed_model_id: string }>(
				"select harness,listed_model_id from agent_session",
			)
		).rows[0];
		expect(row).toEqual({ harness: "api", listed_model_id: "m1" });
	});

	it("is not created for a project that has no workspace row yet", async () => {
		const projectId = await addProject("u", 1);
		expect(await ensureYSquaredChat("u", projectId)).toBeNull();
	});
});

describe("the per-user daily wake cap", () => {
	it("counts wakes across projects and refuses past the cap", async () => {
		expect(await consumeUserWake("u", 2)).toBe(true);
		expect(await consumeUserWake("u", 2)).toBe(true);
		expect(await consumeUserWake("u", 2)).toBe(false);
		expect(await consumeUserWake("v", 2)).toBe(true);
	});
});

describe("the backfill", () => {
	const seed = async () => {
		const never = await addProject("u", 1);
		const optedOut = await addProject("u", 2);
		await db.query(
			"insert into agent_session(id,user_id,project_id,harness,title,status,chat_role,archived_at) values('y','u',$1,'api','Y²','ready','y2',now())",
			[optedOut],
		);
		const explicitOff = await addProject("u", 3);
		await db.query("update project set y_choice='off' where id=$1", [
			explicitOff,
		]);
		const archived = await addProject("v", 4);
		await db.query("update project set archived_at=now() where id=$1", [
			archived,
		]);
		const recentOff = await addProject("v", 5);
		await db.query(
			"update project set created_at=timestamptz '2026-11-24 00:00+00' where id=$1",
			[recentOff],
		);
		const already = await addProject("v", 6);
		await db.query("update project set y_enabled=true where id=$1", [already]);
		return { never, optedOut, explicitOff, archived, recentOff, already };
	};

	it("a dry run changes nothing and counts what an apply would enable", async () => {
		const ids = await seed();
		const report = await ySquaredBackfill(holder, { apply: false });
		expect(report).toMatchObject({
			applied: false,
			enabledProjects: 1,
			enabledUsers: 1,
			keptOff: 2,
		});
		expect((await flags(ids.never)).y_enabled).toBe(false);
	});

	it("enables only never-set live projects, keeps opt-outs off, in batches, and is idempotent", async () => {
		const ids = await seed();
		const report = await ySquaredBackfill(holder, {
			apply: true,
			batchSize: 1,
		});
		expect(report).toMatchObject({
			applied: true,
			enabledProjects: 1,
			keptOff: 2,
		});
		expect((await flags(ids.never)).y_enabled).toBe(true);
		expect(await flags(ids.optedOut)).toEqual({
			y_enabled: false,
			y_choice: "off",
		});
		expect(await flags(ids.explicitOff)).toEqual({
			y_enabled: false,
			y_choice: "off",
		});
		expect(await flags(ids.recentOff)).toEqual({
			y_enabled: false,
			y_choice: "off",
		});
		expect((await flags(ids.archived)).y_enabled).toBe(false);
		const second = await ySquaredBackfill(holder, { apply: true });
		expect(second).toMatchObject({ enabledProjects: 0, keptOff: 0 });
	});

	it("leaves a user who turned Y² off for everything alone", async () => {
		const never = await addProject("u", 1);
		await db.query(
			"insert into user_y_setting(user_id,enabled) values('u',false)",
		);
		const report = await ySquaredBackfill(holder, { apply: true });
		expect(report.enabledProjects).toBe(0);
		expect((await flags(never)).y_enabled).toBe(false);
	});
});
