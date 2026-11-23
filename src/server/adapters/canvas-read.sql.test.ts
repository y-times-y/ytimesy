import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { latestCanvasForOwner } from "./canvas-read";
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

const canvas = (
	id: string,
	title: string,
	revision: number,
	html: string | null,
) => ({ kind: "canvas", id, title, revision, html });

async function chat(items: readonly unknown[], owner = "alice") {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,$2,$3,'api','chat',$4::jsonb)",
		[id, owner, project, JSON.stringify(items)],
	);
	return id;
}

const BASE64 = "Q".repeat(60_000);

it("reads ONE item: the latest revision of the title, whole, with its id", async () => {
	const id = await chat([
		{ kind: "userMessage", id: "u1", text: "art" },
		canvas("c1", "Thread art", 1, "<h1>one</h1>"),
		canvas("c9", "Other", 5, "<h1>other</h1>"),
		canvas("c2", "Thread art", 2, "<h1>two</h1>"),
	]);
	const found = await latestCanvasForOwner(
		"alice",
		id,
		"thread  art".replace("  ", " "),
	);
	expect(found).toMatchObject({
		itemId: "c2",
		title: "Thread art",
		revision: 2,
		html: "<h1>two</h1>",
		latestRevision: 2,
	});
	holder.query.mockClear();
	await latestCanvasForOwner("alice", id, "Thread art");
	expect(holder.query).toHaveBeenCalledTimes(1);
});

it("carries the chat's newest feedback message on that canvas, bounded, and none for another title", async () => {
	const id = await chat([
		canvas("c1", "Thread art", 1, "<h1>one</h1>"),
		{
			kind: "userMessage",
			id: "u1",
			text: 'Canvas feedback on "Thread art" (revision 1), 1 note:\n\n1. Old note',
		},
		{
			kind: "userMessage",
			id: "u2",
			text: `Canvas feedback on "Thread art" (revision 1), 1 note:\n\n1. Bigger title ${"z".repeat(10_000)}`,
		},
		{
			kind: "userMessage",
			id: "u3",
			text: 'Canvas feedback on "Thread art v2" (revision 1), 1 note:',
		},
		canvas("c9", "Other", 1, "<h1>other</h1>"),
	]);
	const found = await latestCanvasForOwner("alice", id, "Thread art");
	expect(found?.feedback).toContain("1. Bigger title");
	expect(found?.feedback?.length).toBe(4_000);
	expect(
		(await latestCanvasForOwner("alice", id, "Other"))?.feedback,
	).toBeUndefined();
});

it("takes the highest revision number, not the last row", async () => {
	const id = await chat([
		canvas("c3", "Thread art", 3, "<h1>three</h1>"),
		canvas("c2", "Thread art", 2, "<h1>two</h1>"),
	]);
	expect(
		(await latestCanvasForOwner("alice", id, "Thread art"))?.revision,
	).toBe(3);
});

it("falls back to the newest revision that still has html and says the latest is newer", async () => {
	const id = await chat([
		canvas("c1", "Thread art", 1, "<h1>one</h1>"),
		canvas("c2", "Thread art", 2, "<h1>two</h1>"),
		canvas("c3", "Thread art", 3, null),
	]);
	expect(await latestCanvasForOwner("alice", id, "Thread art")).toMatchObject({
		revision: 2,
		html: "<h1>two</h1>",
		latestRevision: 3,
	});
});

it("returns null for an unknown title, an empty chat and another user's chat", async () => {
	const id = await chat([canvas("c1", "Thread art", 1, "<p>x</p>")], "bob");
	expect(await latestCanvasForOwner("alice", id, "Thread art")).toBeNull();
	const mine = await chat([canvas("c1", "Thread art", 1, "<p>x</p>")]);
	expect(await latestCanvasForOwner("alice", mine, "Nope")).toBeNull();
	expect(
		await latestCanvasForOwner("alice", await chat([]), "Thread art"),
	).toBeNull();
});

it("the thread outcome lists the latest revision per title with size, images and a description, and little data", async () => {
	const big = `<!doctype html><title>Art board</title><style>${"p{color:red}".repeat(500)}</style><h1>Spring poster</h1><p>Three ideas.</p><img alt="Cat" src="data:image/png;base64,${BASE64}"><script>${"x=1;".repeat(2_000)}</script>`;
	const id = await chat([
		{ kind: "userMessage", id: "u1", text: "go" },
		canvas("c1", "Poster", 1, "<h1>Old</h1>"),
		canvas("c2", "Poster", 2, big),
		canvas("c3", "Flow", 1, "<h1>Flow</h1><p>Steps</p>"),
		canvas("c4", "Poster", 3, big),
	]);
	const outcome = await threadOutcomeForOwner("alice", id);
	const canvases = outcome?.canvases ?? [];
	expect(canvases.map((entry) => [entry.title, entry.revision])).toEqual([
		["Flow", 1],
		["Poster", 3],
	]);
	const poster = canvases[1];
	expect(poster?.hasImages).toBe(true);
	expect(poster?.sizeKb).toBeGreaterThan(60);
	expect(poster?.description).toContain("Spring poster");
	expect(poster?.description).toContain("[image: Cat]");
	expect(poster?.description?.length).toBeLessThanOrEqual(300);
	expect(poster?.description).not.toContain("QQQQ");
	expect(JSON.stringify(outcome)).not.toContain("QQQQ");
	expect(canvases[0]).toMatchObject({
		hasImages: false,
		description: "Flow · Steps",
	});
});
