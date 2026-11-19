import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { threadOutcomeForOwner } from "./thread-outcome";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const user = (id: string, text: string) => ({ kind: "userMessage", id, text });
const say = (id: string, text: string, extra: object = {}) => ({
	kind: "agentMessage",
	id,
	text,
	...extra,
});

async function chat(items: readonly unknown[], owner = "alice") {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,$2,$3,'api','chat',$4::jsonb)",
		[id, owner, project, JSON.stringify(items)],
	);
	return id;
}

it("reads the final turn's full reply, its question and the canvases, not an earlier turn's", async () => {
	const long = `Findings ${"x".repeat(30_000)} VERDICT`;
	const id = await chat([
		user("u1", "first"),
		say("a1", "old reply"),
		user("u2", "audit"),
		say("a2", "Looking", { phase: "commentary" }),
		{
			kind: "canvas",
			id: "c1",
			title: "Board",
			revision: 1,
			html: "<p>big</p>",
		},
		{
			kind: "canvas",
			id: "c2",
			title: "Board",
			revision: 2,
			html: "<p>big</p>",
		},
		say("a3", long, { phase: "final_answer" }),
		{
			kind: "userQuestion",
			id: "q1",
			questions: [
				{ question: "Publish?", options: [{ label: "Yes" }, { label: "No" }] },
			],
		},
	]);
	const outcome = await threadOutcomeForOwner("alice", id);
	const texts = (outcome?.items ?? [])
		.filter((item) => item.kind === "agentMessage")
		.map((item) => (item as { text: string }).text);
	expect(texts).toEqual(["Looking", long]);
	expect(outcome?.items.some((item) => item.kind === "userQuestion")).toBe(
		true,
	);
	// The latest revision of each title, with its size, images flag and description.
	expect(outcome?.canvases).toEqual([
		{
			title: "Board",
			revision: 2,
			sizeKb: 0,
			hasImages: false,
			description: "big",
		},
	]);
});

it("falls back to the chat's last agent message when the final turn said nothing", async () => {
	const id = await chat([
		user("u1", "audit"),
		say("a1", "the report"),
		user("u2", "wake"),
	]);
	const outcome = await threadOutcomeForOwner("alice", id);
	expect(
		outcome?.items.map((item) => (item as { text?: string }).text),
	).toEqual(["the report"]);
});

it("reads nothing of another user's chat", async () => {
	const id = await chat([user("u1", "x"), say("a1", "secret")], "bob");
	const outcome = await threadOutcomeForOwner("alice", id);
	expect(outcome?.items ?? []).toEqual([]);
	expect(outcome?.canvases ?? []).toEqual([]);
});
