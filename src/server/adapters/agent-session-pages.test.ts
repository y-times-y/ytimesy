import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import {
	latestTranscriptPage,
	olderTranscriptPage,
} from "#/domain/transcript-page";
import {
	agentSessionPageForOwner,
	listSidebarAgentSessions,
} from "./agent-sessions";

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

/** Turn `n`: the user's message, some work, the reply; every third is a wake-up turn. */
function turnItems(n: number): SessionItem[] {
	const start: SessionItem =
		n % 3 === 2
			? { kind: "notice", id: `t${n}` as never, message: "", wake: true }
			: { kind: "userMessage", id: `t${n}` as never, text: `ask ${n}` };
	return [
		start,
		{
			kind: "commandExecution",
			id: `t${n}-cmd` as never,
			command: "ls",
			cwd: null,
			status: "completed",
			output: "",
			exitCode: 0,
		},
		{ kind: "agentMessage", id: `t${n}-reply` as never, text: `reply ${n}` },
	];
}

async function chat(items: readonly unknown[], user = "alice") {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,$2,$3,'codex','chat',$4::jsonb)",
		[id, user, project, JSON.stringify(items)],
	);
	return id;
}

const ids = (items: unknown) =>
	(items as SessionItem[]).map((item) => item.id as string);

it("reads the last turns whole, then each page before the oldest item read, until none is older", async () => {
	const items = Array.from({ length: 7 }, (_, n) => turnItems(n)).flat();
	const id = await chat(items);

	const latest = await agentSessionPageForOwner("alice", id, { turns: 3 });
	expect(ids(latest?.items)).toEqual(ids(items.slice(12)));
	expect(latest).toMatchObject({ hasOlderItems: true, pageFound: true });

	const second = await agentSessionPageForOwner("alice", id, {
		turns: 3,
		beforeId: "t4",
	});
	expect(ids(second?.items)).toEqual(ids(items.slice(3, 12)));
	expect(second?.hasOlderItems).toBe(true);

	const last = await agentSessionPageForOwner("alice", id, {
		turns: 3,
		beforeId: "t1",
	});
	expect(ids(last?.items)).toEqual(ids(items.slice(0, 3)));
	expect(last?.hasOlderItems).toBe(false);
});

it("matches the page the browser's own code cuts, for every cursor", async () => {
	const items = [
		// Items before the first turn start belong to the oldest page.
		{ kind: "agentMessage", id: "lead", text: "hello" },
		...Array.from({ length: 10 }, (_, n) => turnItems(n)).flat(),
	] as SessionItem[];
	const id = await chat(items);
	for (const turns of [1, 2, 4, 30]) {
		const latest = await agentSessionPageForOwner("alice", id, { turns });
		const expected = latestTranscriptPage(items, turns);
		expect(ids(latest?.items)).toEqual(ids(expected.items));
		expect(latest?.hasOlderItems).toBe(expected.hasOlderItems);
		for (const item of items) {
			const page = await agentSessionPageForOwner("alice", id, {
				turns,
				beforeId: item.id,
			});
			const cut = olderTranscriptPage(items, item.id, turns);
			expect(ids(page?.items)).toEqual(ids(cut?.items));
			expect(page?.hasOlderItems).toBe(cut?.hasOlderItems);
		}
	}
});

it("pages an oversized single turn without dropping or duplicating any work", async () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: "large-request" as never,
			text: "Inspect the atlas",
			contextUsage: {
				context: { last: { totalTokens: 54321 }, modelContextWindow: 200000 },
				compacting: false,
			},
		},
		...Array.from(
			{ length: 511 },
			(_, index): SessionItem => ({
				kind: "agentMessage",
				id: `atlas-${index}` as never,
				text: "λ🛰️".repeat(900),
			}),
		),
	];
	const id = await chat(items);
	let cursor: string | undefined;
	let collected: SessionItem[] = [];
	for (let pages = 0; ; pages++) {
		expect(pages).toBeLessThan(100);
		const page = await agentSessionPageForOwner("alice", id, {
			turns: 30,
			beforeId: cursor,
		});
		expect(page?.pageFound).toBe(true);
		expect(page?.contextUsage?.context?.last.totalTokens).toBe(54321);
		const pageItems = sessionItemsFromUnknown(page?.items);
		expect(pageItems.length).toBeGreaterThan(0);
		expect(pageItems.length).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(JSON.stringify(page?.items))).toBeLessThan(
			270_000,
		);
		collected = [...pageItems, ...collected];
		if (!page?.hasOlderItems) break;
		cursor = pageItems[0]?.id;
	}
	expect(ids(collected)).toEqual(ids(items));
	expect(new Set(ids(collected)).size).toBe(items.length);
});

it("reads an empty chat, a cursor the transcript lost, and nothing of another user's chat", async () => {
	const empty = await chat([]);
	expect(
		await agentSessionPageForOwner("alice", empty, { turns: 30 }),
	).toMatchObject({ items: [], hasOlderItems: false, pageFound: true });

	const id = await chat(turnItems(0));
	expect(
		await agentSessionPageForOwner("alice", id, {
			turns: 30,
			beforeId: "gone",
		}),
	).toMatchObject({ items: [], hasOlderItems: false, pageFound: false });
	expect(await agentSessionPageForOwner("bob", id, { turns: 30 })).toBeNull();
});

it("lists each chat with what it waits on, not its items", async () => {
	await chat([
		...turnItems(0),
		{ kind: "userMessage", id: "q", text: "pick" },
		{ kind: "userQuestion", id: "ask", questions: [] },
	]);
	const [listed] = await listSidebarAgentSessions("alice", project);
	expect(listed).toMatchObject({ waitingOn: "question" });
	expect(listed && "items" in listed).toBe(false);
});

it("keeps one row per item in step with every rewrite of the stored array", async () => {
	const mirrored = async (id: string) => {
		const result = await db.query<{ same: boolean; rows: number }>(
			`select coalesce((select jsonb_agg(i.item order by i.position) from agent_session_item i where i.session_id=s.id),'[]'::jsonb)
			  = (case when jsonb_typeof(s.items)='array' then s.items else '[]'::jsonb end) as same,
			 (select count(*)::int from agent_session_item i where i.session_id=s.id) as rows
			 from agent_session s where s.id=$1`,
			[id],
		);
		return result.rows[0];
	};
	const items = Array.from({ length: 4 }, (_, n) => turnItems(n)).flat();
	const id = await chat(items);
	const write = async (next: unknown) => {
		await db.query("update agent_session set items=$2::jsonb where id=$1", [
			id,
			JSON.stringify(next),
		]);
		expect(await mirrored(id)).toMatchObject({ same: true });
	};
	// Append, edit in place, insert in the middle, truncate, empty, not an array.
	await write([...items, { kind: "agentMessage", id: "more", text: "more" }]);
	await write(
		items.map((item, n) =>
			n === 4 ? { ...item, text: "edited", status: "failed" } : item,
		),
	);
	await write([...items.slice(0, 3), turnItems(9)[0], ...items.slice(3)]);
	await write(items.slice(0, 5));
	const page = await agentSessionPageForOwner("alice", id, { turns: 1 });
	expect(ids(page?.items)).toEqual(ids(items.slice(3, 5)));
	await db.query(
		`update agent_session set items=items || '[{"kind":"userMessage","id":"x","text":"x"}]'::jsonb where id=$1`,
		[id],
	);
	expect(await mirrored(id)).toMatchObject({ same: true, rows: 6 });
	await write([]);
	expect(await mirrored(id)).toMatchObject({ rows: 0 });
	await write({ kind: "userMessage" });
	await write(items);
	await db.query("delete from agent_session where id=$1", [id]);
	expect(
		(await db.query("select count(*)::int as n from agent_session_item")).rows,
	).toEqual([{ n: 0 }]);
});

it("copies histories stored before the item table existed", async () => {
	const fresh = new PGlite();
	await fresh.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,items jsonb not null default '[]',turn_status text default 'idle');`);
	const items = Array.from({ length: 3 }, (_, n) => turnItems(n)).flat();
	const sessions = Array.from({ length: 450 }, () => randomUUID());
	for (const id of sessions)
		await fresh.query(
			"insert into agent_session(id,items,turn_status) values($1,$2::jsonb,'completed')",
			[id, JSON.stringify(id === sessions[7] ? [] : items)],
		);
	await fresh.query(
		`update agent_session set items=items || '[{"kind":"userQuestion","id":"q"}]'::jsonb where id=$1`,
		[sessions[3]],
	);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
	])
		await fresh.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	const counts = await fresh.query<{ n: number; starts: number }>(
		"select count(*)::int as n, count(*) filter (where starts_turn)::int as starts from agent_session_item",
	);
	expect(counts.rows).toEqual([{ n: 449 * items.length + 1, starts: 449 * 3 }]);
	const waiting = await fresh.query<{ id: string; waiting_on: string }>(
		"select id,waiting_on from agent_session where waiting_on is not null",
	);
	expect(waiting.rows).toEqual([{ id: sessions[3], waiting_on: "question" }]);
	await fresh.close();
});
