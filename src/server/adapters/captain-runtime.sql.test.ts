import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAPTAIN_COLORS } from "#/domain/captain";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

import { createCaptain, listCaptains } from "./captains";
import {
	isActiveYSquaredChat,
	isYSquaredSession,
	projectYMode,
} from "./y-mode";

let db: PGlite;
const project = randomUUID();
let leader: string;
let thread: string;

beforeEach(async () => {
	db = new PGlite();
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
	insert into auth_user values ('alice');
	insert into project(id,user_id) values ('${project}','alice');`);
	leader = randomUUID();
	thread = randomUUID();
	await db.query(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,chat_role)
		 values ($1,'alice',$3,gen_random_uuid(),'api','Y²','m','idle','y2'),
		        ($2,'alice',$3,gen_random_uuid(),'api','A thread','m','idle',null)`,
		[leader, thread, project],
	);
	await db.exec(
		readFileSync("supabase/migrations/20261126130000_captains.sql", "utf8"),
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function captainChat() {
	await createCaptain("alice", project, {
		name: "seo",
		label: "content",
		color: CAPTAIN_COLORS[0],
		rolePrompt: "Own SEO.",
	});
	return (await listCaptains("alice", project))[0].chatId;
}

it("tells a turn that its chat is a captain, with the role it runs on", async () => {
	const chat = await captainChat();
	const mode = await projectYMode("alice", project, chat);
	expect(mode?.ySquaredId).toBe(leader);
	expect(mode?.captain).toMatchObject({
		name: "seo",
		label: "content",
		rolePrompt: "Own SEO.",
	});
});

it("the leader and a thread are not captains", async () => {
	await captainChat();
	expect((await projectYMode("alice", project, leader))?.captain).toBeNull();
	expect((await projectYMode("alice", project, thread))?.captain).toBeNull();
	// No session asked about: no captain field at all (the old shape).
	expect(await projectYMode("alice", project)).not.toHaveProperty("captain");
});

it("another person's captain is never reported", async () => {
	const chat = await captainChat();
	expect(await projectYMode("bob", project, chat)).toBeNull();
});

it("a captain chat has no machine, like the leader: active Super agent, but a thread does", async () => {
	const chat = await captainChat();
	expect(await isActiveYSquaredChat("alice", project, { id: chat })).toBe(true);
	expect(await isActiveYSquaredChat("alice", project, { id: leader })).toBe(
		true,
	);
	expect(await isActiveYSquaredChat("alice", project, { id: thread })).toBe(
		false,
	);
});

it("a deleted captain's chat is no longer a Super agent", async () => {
	const chat = await captainChat();
	const [mine] = await listCaptains("alice", project);
	await db.query("update captain set archived_at=now() where id=$1", [mine.id]);
	expect(await isActiveYSquaredChat("alice", project, { id: chat })).toBe(
		false,
	);
});

it("sessions of Y² and of captains refuse the thread-to-thread tools; threads do not", async () => {
	const chat = await captainChat();
	expect(await isYSquaredSession("alice", chat)).toBe(true);
	expect(await isYSquaredSession("alice", leader)).toBe(true);
	expect(await isYSquaredSession("alice", thread)).toBe(false);
});

it("a project with Y² off treats a captain chat as an ordinary chat", async () => {
	const chat = await captainChat();
	await db.query("update project set y_enabled=false where id=$1", [project]);
	expect(await isActiveYSquaredChat("alice", project, { id: chat })).toBe(
		false,
	);
	expect(await isYSquaredSession("alice", chat)).toBe(false);
});
