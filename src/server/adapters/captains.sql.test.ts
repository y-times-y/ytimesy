import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAPTAIN_COLORS, CAPTAIN_LIMIT } from "#/domain/captain";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

import {
	archiveCaptainRow,
	captainForChat,
	createCaptain,
	listCaptains,
	recordCaptainLine,
	renameLeader,
	updateCaptain,
} from "./captains";

let db: PGlite;
const project = randomUUID();
const other = randomUUID();
const input = (name: string, patch: Record<string, unknown> = {}) => ({
	name,
	label: null,
	color: CAPTAIN_COLORS[0],
	rolePrompt: "Look after things.",
	...patch,
});

beforeEach(async () => {
	db = new PGlite();
	// The schema this migration extends: the tables it references, and the
	// chat_role column with the unnamed check the real migration replaces.
	await db.exec(`create role anon; create role authenticated;
	create table auth_user(id text primary key);
	create table project(id uuid primary key, user_id text not null references auth_user(id),
	 y_enabled boolean not null default true, name text, archived_at timestamptz);
	create table agent_session(id uuid primary key, user_id text, project_id uuid, workspace_id uuid,
	 harness text not null, title text not null, listed_model_id text, status text not null,
	 chat_role text check (chat_role = 'y2'), parent_session_id uuid, archived_at timestamptz,
	 items jsonb not null default '[]', turn_status text not null default 'idle', waiting_on jsonb,
	 updated_at timestamptz not null default now(),
	 constraint agent_session_y2_is_root check (chat_role is null or parent_session_id is null));
	create unique index agent_session_one_y2 on agent_session(user_id, project_id)
	 where chat_role='y2' and archived_at is null;
	insert into auth_user values ('alice'),('bob');
	insert into project(id,user_id) values ('${project}','alice'),('${other}','bob');
	insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,chat_role)
	 values (gen_random_uuid(),'alice','${project}',gen_random_uuid(),'api','Y²','claude-opus-5-5','idle','y2'),
	        (gen_random_uuid(),'bob','${other}',gen_random_uuid(),'api','Y²','gpt','idle','y2');`);
	await db.exec(
		readFileSync("supabase/migrations/20261126130000_captains.sql", "utf8"),
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

it("the migration lets a chat be a captain and still refuses other roles", async () => {
	await expect(
		db.query(
			"insert into agent_session(id,user_id,project_id,harness,title,status,chat_role) values (gen_random_uuid(),'alice',$1,'api','x','idle','boss')",
			[project],
		),
	).rejects.toThrow();
});

it("creates a captain with its own chat beside the leader's route, and lists it", async () => {
	const made = await createCaptain(
		"alice",
		project,
		input("seo", { label: "content" }),
	);
	expect(made.ok).toBe(true);
	const list = await listCaptains("alice", project);
	expect(list).toHaveLength(1);
	expect(list[0]).toMatchObject({
		name: "seo",
		label: "content",
		color: CAPTAIN_COLORS[0],
		rolePrompt: "Look after things.",
		turnStatus: "idle",
		needsYou: false,
	});
	const chat = await db.query<Record<string, unknown>>(
		"select chat_role, title, harness, listed_model_id, parent_session_id, status, items from agent_session where id=$1",
		[list[0].chatId],
	);
	expect(chat.rows[0]).toMatchObject({
		chat_role: "captain",
		title: "seo",
		harness: "api",
		listed_model_id: "claude-opus-5-5",
		parent_session_id: null,
	});
	expect(JSON.stringify(chat.rows[0].items)).toContain("I'm seo");
});

it("holds at most five live captains per project, and a deleted one frees a place", async () => {
	for (let i = 0; i < CAPTAIN_LIMIT; i++)
		expect((await createCaptain("alice", project, input(`c${i}`))).ok).toBe(
			true,
		);
	const sixth = await createCaptain("alice", project, input("c5"));
	expect(sixth).toMatchObject({ ok: false });
	expect(!sixth.ok && sixth.error).toMatch(/5 captains/);
	const list = await listCaptains("alice", project);
	await archiveCaptainRow("alice", list[0].id);
	expect((await createCaptain("alice", project, input("c5"))).ok).toBe(true);
});

it("refuses a name a live captain already has, ignoring case, but frees it on delete", async () => {
	await createCaptain("alice", project, input("SEO"));
	const again = await createCaptain("alice", project, input("seo"));
	expect(again.ok).toBe(false);
	expect(!again.ok && again.error).toMatch(/already/);
	const [first] = await listCaptains("alice", project);
	await archiveCaptainRow("alice", first.id);
	expect((await createCaptain("alice", project, input("seo"))).ok).toBe(true);
});

it("refuses a project that is not the person's, has Y² off, or has no leader chat yet", async () => {
	expect((await createCaptain("alice", other, input("seo"))).ok).toBe(false);
	await db.query("update project set y_enabled=false where id=$1", [project]);
	expect((await createCaptain("alice", project, input("seo"))).ok).toBe(false);
	await db.query("update project set y_enabled=true where id=$1", [project]);
	await db.query(
		"update agent_session set archived_at=now() where project_id=$1",
		[project],
	);
	const noLeader = await createCaptain("alice", project, input("seo"));
	expect(!noLeader.ok && noLeader.error).toMatch(/Super agent/);
});

it("never lists another person's captains or lets them change one", async () => {
	await createCaptain("alice", project, input("seo"));
	expect(await listCaptains("bob", project)).toEqual([]);
	const [mine] = await listCaptains("alice", project);
	expect((await updateCaptain("bob", mine.id, input("hacked"))).ok).toBe(false);
	expect(await archiveCaptainRow("bob", mine.id)).toBeNull();
	expect((await listCaptains("alice", project))[0].name).toBe("seo");
});

it("renames, relabels and re-roles a captain and keeps its chat title in step", async () => {
	await createCaptain("alice", project, input("seo"));
	const [mine] = await listCaptains("alice", project);
	const changed = await updateCaptain(
		"alice",
		mine.id,
		input("search", {
			label: "growth",
			color: CAPTAIN_COLORS[3],
			rolePrompt: "New role.",
		}),
	);
	expect(changed.ok).toBe(true);
	const [after] = await listCaptains("alice", project);
	expect(after).toMatchObject({
		name: "search",
		label: "growth",
		color: CAPTAIN_COLORS[3],
		rolePrompt: "New role.",
	});
	const title = await db.query<{ title: string }>(
		"select title from agent_session where id=$1",
		[mine.chatId],
	);
	expect(title.rows[0].title).toBe("search");
});

it("refuses renaming a captain to another's name", async () => {
	await createCaptain("alice", project, input("seo"));
	await createCaptain("alice", project, input("news"));
	const [seo] = await listCaptains("alice", project);
	const clash = await updateCaptain("alice", seo.id, input("NEWS"));
	expect(clash.ok).toBe(false);
});

it("deleting archives the captain and its chat; the chat is no longer a live captain", async () => {
	await createCaptain("alice", project, input("seo"));
	const [mine] = await listCaptains("alice", project);
	expect(await archiveCaptainRow("alice", mine.id)).toEqual({
		chatId: mine.chatId,
	});
	expect(await listCaptains("alice", project)).toEqual([]);
	expect(await captainForChat("alice", mine.chatId)).toBeNull();
	const chat = await db.query<{ archived_at: unknown }>(
		"select archived_at from agent_session where id=$1",
		[mine.chatId],
	);
	expect(chat.rows[0].archived_at).not.toBeNull();
});

it("reads a captain by its chat, for its turn", async () => {
	await createCaptain("alice", project, input("seo", { label: "content" }));
	const [mine] = await listCaptains("alice", project);
	expect(await captainForChat("alice", mine.chatId)).toMatchObject({
		id: mine.id,
		name: "seo",
		label: "content",
		rolePrompt: "Look after things.",
		projectId: project,
	});
	expect(await captainForChat("bob", mine.chatId)).toBeNull();
	expect(await captainForChat("alice", randomUUID())).toBeNull();
});

it("records the first line of its last answer, cut to 200 characters", async () => {
	await createCaptain("alice", project, input("seo"));
	const [mine] = await listCaptains("alice", project);
	await recordCaptainLine(
		mine.chatId,
		`  Found 6 pages missing meta.\n\nSecond paragraph ${"x".repeat(300)}`,
	);
	const [after] = await listCaptains("alice", project);
	expect(after.lastLine).toBe("Found 6 pages missing meta.");
	expect(after.lastAt).not.toBeNull();
	await recordCaptainLine(mine.chatId, "x".repeat(500));
	expect(
		(await listCaptains("alice", project))[0].lastLine?.length,
	).toBeLessThanOrEqual(200);
});

it("lists working and waiting captains from their chats", async () => {
	await createCaptain("alice", project, input("seo"));
	const [mine] = await listCaptains("alice", project);
	await db.query("update agent_session set turn_status='running' where id=$1", [
		mine.chatId,
	]);
	expect((await listCaptains("alice", project))[0].turnStatus).toBe("running");
	await db.query(
		`update agent_session set waiting_on='{"kind":"question"}' where id=$1`,
		[mine.chatId],
	);
	expect((await listCaptains("alice", project))[0].needsYou).toBe(true);
});

it("renames the leader, or clears the name", async () => {
	expect(await renameLeader("alice", project, "otto")).toBe(true);
	expect(
		(
			await db.query<{ leader_name: string | null }>(
				"select leader_name from project where id=$1",
				[project],
			)
		).rows[0].leader_name,
	).toBe("otto");
	expect(await renameLeader("alice", project, null)).toBe(true);
	expect(await renameLeader("bob", project, "evil")).toBe(false);
	expect(
		(
			await db.query<{ leader_name: string | null }>(
				"select leader_name from project where id=$1",
				[project],
			)
		).rows[0].leader_name,
	).toBeNull();
});
