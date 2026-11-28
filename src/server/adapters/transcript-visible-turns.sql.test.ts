import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { childTaskEventQueueText } from "#/domain/child-task-activity";
import { openPageForOwner } from "./agent-sessions";

/**
 * A Super agent chat is mostly hidden wake turns (a helper's report, a crew
 * note) with the person's own messages among them. A page counts turns, and
 * a wake start used to count as one: after a few wakes the person's last
 * message sat in "older history" and only the agent's replies showed. Run on
 * a real Postgres (PGlite) with the real migrations.
 */
const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),chat_role text,environment_setup boolean default false,thread_number int,machine_released_at timestamptz,task_pr_url text,x_unused int);
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());`);
	for (const file of [
		"20261001120000_conversation_delivery",
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261105100000_agent_session_items_rev",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
}, 60_000);
afterEach(() => db.close());

type Stored = {
	kind: string;
	id: string;
	text?: string;
	status?: string;
	tool?: string;
};
const person = (id: string): Stored => ({
	kind: "userMessage",
	id,
	text: `person ${id}`,
});
const wake = (n: number): Stored => ({
	kind: "userMessage",
	id: `wake-${n}`,
	text:
		childTaskEventQueueText(
			`0000000${n}-0d4b-4c51-9a63-2f8f5b1d7e10`.slice(-36),
		) + "x".repeat(2_000),
});
const reply = (id: string): Stored => ({
	kind: "agentMessage",
	id,
	text: `reply ${id}`,
});
const tool = (id: string): Stored => ({
	kind: "dynamicToolCall",
	id,
	tool: "bash",
	status: "completed",
});

/** `wakes` hidden wake turns (start, tool, reply each). */
const wakeTurns = (from: number, wakes: number): Stored[] =>
	Array.from({ length: wakes }, (_, index) => [
		wake(from + index),
		tool(`t-${from + index}`),
		reply(`a-${from + index}`),
	]).flat();

async function chat(items: Stored[]) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,title,items,turn_status,chat_role) values($1,'alice','api','Super agent',$2::jsonb,'idle','y2')",
		[id, JSON.stringify(items)],
	);
	return id;
}

const ids = (read: { items?: unknown } | null) =>
	((read?.items ?? []) as { id: string }[]).map((item) => item.id);

it("the person's latest message is in the open page after many wake turns", async () => {
	const id = await chat([
		person("p1"),
		reply("r1"),
		...wakeTurns(100, 30),
		person("p2"),
		reply("r2"),
		...wakeTurns(200, 12),
	]);
	const read = await openPageForOwner("alice", id);
	expect(ids(read)).toContain("p2");
	expect(ids(read)).toContain("r2");
});

it("pages count the person's turns, whatever the wake turns between them", async () => {
	const id = await chat([
		person("p1"),
		reply("r1"),
		...wakeTurns(100, 40),
		person("p2"),
		reply("r2"),
		...wakeTurns(200, 40),
		person("p3"),
		reply("r3"),
		...wakeTurns(300, 40),
	]);
	const read = await openPageForOwner("alice", id);
	// Four person turns would reach p1; the page holds at least the last two.
	expect(ids(read)).toContain("p3");
	expect(ids(read)).toContain("p2");
	expect(read?.hasOlderItems).toBeDefined();
});

it("a chat of only wake turns still opens (nothing to anchor on)", async () => {
	const id = await chat(wakeTurns(100, 10));
	const read = await openPageForOwner("alice", id);
	expect(ids(read).length).toBeGreaterThan(0);
});

it("reaches back to the person's latest message past the item limit when wakes follow it", async () => {
	// 150 wake turns = 150 visible replies after p2, plus hidden starts: under
	// the 200-item page limit, and 350 visible items (250 wakes) is past it.
	const id = await chat([
		person("p1"),
		reply("r1"),
		person("p2"),
		reply("r2"),
		...wakeTurns(200, 260),
	]);
	const read = await openPageForOwner("alice", id);
	expect(ids(read)).toContain("p2");
});

it("beyond the anchor distance the page stays bounded", async () => {
	const id = await chat([
		person("p1"),
		reply("r1"),
		person("p2"),
		reply("r2"),
		...wakeTurns(200, 700),
	]);
	const read = await openPageForOwner("alice", id);
	expect(ids(read)).not.toContain("p2");
	expect(read?.hasOlderItems).toBe(true);
	// Visible items only: hidden starts are not counted, so 200 replies and 200 tools.
	expect((read?.items as unknown[]).length).toBeLessThan(1_000);
});

it("a hidden wake start leaves the database as a stub, not its whole report", async () => {
	const id = await chat([person("p1"), reply("r1"), ...wakeTurns(100, 3)]);
	const read = await openPageForOwner("alice", id);
	const stubs = ((read?.items ?? []) as { id: string; text?: string }[]).filter(
		(item) => item.id.startsWith("wake-"),
	);
	expect(stubs.length).toBe(3);
	for (const item of stubs)
		expect((item.text ?? "").length).toBeLessThanOrEqual(64);
});

it("one long turn of the person still splits at the item limit (no wakes to anchor on)", async () => {
	const turn = Array.from({ length: 300 }, (_, index) =>
		reply(`long-${index}`),
	);
	const id = await chat([person("p1"), ...turn]);
	const read = await openPageForOwner("alice", id);
	expect(ids(read)).not.toContain("p1");
	expect(read?.hasOlderItems).toBe(true);
});
