import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import {
	applySessionDelta,
	type SessionReadDelta,
} from "#/domain/session-delta";
import type { SessionItem } from "#/domain/session-item";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	OPEN_PAGE_MIN_ITEMS,
	OPEN_PAGE_MIN_TURNS,
	OPEN_PAGE_TURNS,
} from "#/domain/transcript-page";
import { sessionDeltaChange } from "../services/session-delta-change";
import {
	transcriptDeltaForOwner,
	transcriptTokenForOwner,
} from "./agent-session-delta";
import { agentSessionPageForOwner, openPageForOwner } from "./agent-sessions";
import {
	EGRESS_SUMMARY_INTERVAL_MS,
	flushEgressSummary,
	resetEgressSummary,
} from "./database-byte-accounting";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
let logged: string[] = [];
beforeEach(async () => {
	resetEgressSummary();
	logged = [];
	vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	});
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,thread_number integer,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261105100000_agent_session_items_rev",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	await db.close();
});

const BIG = "x".repeat(6000);

/** A turn: a user message, `tools` tool calls with large output, a canvas, a reply. */
function turn(n: number, tools = 2): Record<string, unknown>[] {
	return [
		{ kind: "userMessage", id: `u${n}`, text: `ask ${n}` },
		...Array.from({ length: tools }, (_, t) => ({
			kind: "dynamicToolCall",
			id: `t${n}-${t}`,
			tool: "run_command",
			status: "completed",
			input: { command: `cmd ${n}` },
			output: BIG,
		})),
		{ kind: "canvas", id: `c${n}`, title: "c", html: BIG },
		{ kind: "agentMessage", id: `a${n}`, text: `reply ${n}` },
	];
}

async function chat(items: readonly unknown[]) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,'alice',$2,'api','chat',$3::jsonb)",
		[id, randomUUID(), JSON.stringify(items)],
	);
	return id;
}

const setItems = (id: string, items: readonly unknown[]) =>
	db.query("update agent_session set items=$2::jsonb where id=$1", [
		id,
		JSON.stringify(items),
	]);

function parsed(items: unknown) {
	return childTaskPublicItems(sessionItemsFromUnknown(items));
}

async function page(id: string, turns: number) {
	const read = await openPageForOwner("alice", id, turns);
	if (!read) throw new Error("missing chat");
	return { ...read, shown: parsed(read.items) };
}

const bytes = (value: unknown) => JSON.stringify(value).length;

type Held = {
	items: readonly SessionItem[];
	rev: number;
	count: number;
	turnStatus: "idle";
	workspaceId: null;
	listedModelId: string;
	hasOlderItems?: boolean;
};

async function hold(id: string, turns: number): Promise<Held> {
	const token = await transcriptTokenForOwner("alice", id);
	const read = await page(id, turns);
	return {
		items: read.shown,
		rev: token?.rev ?? 0,
		count: token?.count ?? 0,
		turnStatus: "idle",
		workspaceId: null,
		listedModelId: "",
		hasOlderItems: read.hasOlderItems,
	};
}

/** One refocus read as the browser takes it: a delta merged over the held page, or null (read a page). */
async function refocus(id: string, held: Held) {
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: held.rev,
		count: held.count,
	});
	if (!found) throw new Error("missing chat");
	const change = found.fromPosition === null ? null : sessionDeltaChange(found);
	if (found.fromPosition !== null && !change) return null;
	const delta: SessionReadDelta = {
		mode: "delta",
		token: found.token,
		row: {
			turnStatus: "idle",
			workspaceId: null,
			selectedBranch: null,
			listedModelId: "",
		},
		change: change ?? null,
		queued: [],
	};
	const merged = applySessionDelta(
		{
			view: held,
			token: { rev: held.rev, count: held.count },
			queuedCount: 0,
			fullAt: 0,
		} as never,
		delta,
		false,
	);
	if (!merged) return null;
	const next: Held = {
		...held,
		items: (merged.view as { items: readonly SessionItem[] }).items,
		rev: found.token.rev,
		count: found.token.count,
	};
	return { next, found };
}

const turnStarts = (items: readonly SessionItem[]) =>
	items.filter((item) => item.kind === "userMessage").length;

function summary() {
	flushEgressSummary(Date.now() + EGRESS_SUMMARY_INTERVAL_MS);
	return JSON.parse(
		logged.find((line) => line.includes("db.egress_summary")) ?? "{}",
	);
}

it("an unchanged chat answers a refocus with zero items, and counts it as a skipped page read", async () => {
	const id = await chat(Array.from({ length: 12 }, (_, n) => turn(n)).flat());
	const held = await hold(id, OPEN_PAGE_TURNS);
	const whole = await page(id, OPEN_PAGE_TURNS);
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: held.rev,
		count: held.count,
	});
	expect(found?.fromPosition).toBeNull();
	expect(found?.tail).toEqual([]);
	const answerBytes = bytes(found);
	console.log(
		`measured: unchanged answer ${answerBytes} B vs ${OPEN_PAGE_TURNS}-turn page ${bytes(whole.items)} B`,
	);
	expect(answerBytes).toBeLessThan(1000);
	expect(bytes(whole.items)).toBeGreaterThan(answerBytes * 20);
	const line = summary();
	expect(line.sessionPageReadsSkipped).toEqual({ unchanged: 1, delta: 0 });
	expect(line.sessionPageReads).toBe(2); // hold() and whole
});

it("a delta carries only the changed rows, cut as a page cuts them, and merges to the fresh page", async () => {
	const all = Array.from({ length: 12 }, (_, n) => turn(n)).flat();
	const id = await chat(all);
	const held = await hold(id, OPEN_PAGE_TURNS);
	const changed = [
		...all,
		{ kind: "agentMessage", id: "a11-more", text: "more" },
		...turn(12).slice(0, 2),
	];
	await setItems(id, changed);
	const result = await refocus(id, held);
	expect(result).not.toBeNull();
	const { next, found } = result as NonNullable<typeof result>;
	expect(found.tail.length).toBeLessThan(5);
	const fresh = await page(id, turnStarts(next.items));
	expect(next.items).toEqual(fresh.shown);
	for (const item of found.tail as {
		kind: string;
		html?: unknown;
		output?: string;
	}[]) {
		if (item.kind === "canvas") expect(item.html).toBeNull();
		expect((item.output ?? "").length).toBeLessThan(3000);
	}
	console.log(
		`measured: delta ${bytes(found.tail)} B vs page ${bytes(fresh.items)} B`,
	);
	expect(bytes(found.tail)).toBeLessThan(bytes(fresh.items) / 2);
	expect(summary().sessionPageReadsSkipped.delta).toBe(1);
});

it("a delta over canvases and long tool output is capped like a page (no html leaves the database)", async () => {
	const all = Array.from({ length: 6 }, (_, n) => turn(n)).flat();
	const id = await chat(all);
	const held = await hold(id, OPEN_PAGE_TURNS);
	await setItems(
		id,
		all.map((item) =>
			item.id === "u2" ? { ...item, text: "edited ask" } : item,
		),
	);
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: held.rev,
		count: held.count,
	});
	expect(found?.tail.length).toBeGreaterThan(5);
	// Uncut, this tail is 4 canvases + 8 tool outputs of 6 KB (~72 KB).
	expect(bytes(found?.tail)).toBeLessThan(30_000);
});

it("an edited (streamed) item inside the held page is replaced, not duplicated", async () => {
	const all = Array.from({ length: 8 }, (_, n) => turn(n, 1)).flat();
	const id = await chat(all);
	const held = await hold(id, OPEN_PAGE_TURNS);
	await setItems(
		id,
		all.map((item) =>
			item.id === "a7" ? { ...item, text: "reply 7, longer now" } : item,
		),
	);
	const result = await refocus(id, held);
	expect(result).not.toBeNull();
	const next = (result as NonNullable<typeof result>).next;
	const fresh = await page(id, turnStarts(next.items));
	expect(next.items).toEqual(fresh.shown);
	expect(next.items.filter((item) => item.id === "a7")).toHaveLength(1);
});

it("a revision gap (an edit older than the held page) cannot be applied: the reader reads a page", async () => {
	const all = Array.from({ length: 12 }, (_, n) => turn(n, 1)).flat();
	const id = await chat(all);
	const held = await hold(id, OPEN_PAGE_TURNS);
	await setItems(
		id,
		all.map((item) =>
			item.id === "a1" ? { ...item, text: "rewritten" } : item,
		),
	);
	expect(await refocus(id, held)).toBeNull();
});

it("a revision ahead of the chat (a restored database) is detectable from the token", async () => {
	const id = await chat(turn(0));
	const token = await transcriptTokenForOwner("alice", id);
	const ahead = (token?.rev ?? 0) + 50;
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: ahead,
		count: token?.count ?? 0,
	});
	// readSessionSince reads a page when `found.token.rev < since.rev`.
	expect((found?.token.rev ?? Number.POSITIVE_INFINITY) < ahead).toBe(true);
});

it("differential: after random edit sequences the delta-merged transcript equals a fresh page", async () => {
	let seed = 777;
	const random = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	let items: Record<string, unknown>[] = Array.from({ length: 10 }, (_, n) =>
		turn(n, 1),
	).flat();
	let nextTurn = 10;
	const id = await chat(items);
	let held = await hold(id, OPEN_PAGE_TURNS);
	let applied = 0;
	let pages = 0;
	for (let round = 0; round < 60; round++) {
		const kind = random(5);
		if (kind === 0) items = [...items, ...turn(nextTurn++, random(2))];
		else if (kind === 1) {
			const last = items.length - 1;
			items = items.map((item, at) =>
				at === last && typeof item.text === "string"
					? { ...item, text: `${item.text}+` }
					: item,
			);
		} else if (kind === 2) {
			const at = items.length - 1 - random(4);
			items = items.map((item, i) =>
				i === at && item.kind === "dynamicToolCall"
					? { ...item, status: "failed", output: `${BIG}!` }
					: item,
			);
		} else if (kind === 3 || round % 15 === 14) {
			items = items.map((item, i) =>
				i === 1 ? { ...item, text: `old ${round}` } : item,
			);
		}
		await setItems(id, items);
		const result = await refocus(id, held);
		if (!result) {
			pages++;
			held = await hold(id, OPEN_PAGE_TURNS);
			continue;
		}
		applied++;
		const fresh = await page(id, turnStarts(result.next.items));
		expect(result.next.items).toEqual(fresh.shown);
		held = result.next;
	}
	expect(applied).toBeGreaterThan(20);
	expect(pages).toBeGreaterThan(0);
});

it("the first page is OPEN_PAGE_TURNS turns, never fewer than the last two, and a running turn is whole", async () => {
	expect(OPEN_PAGE_TURNS).toBe(4);
	expect(OPEN_PAGE_MIN_TURNS).toBe(2);
	const items = Array.from({ length: 12 }, (_, n) => turn(n, 6)).flat();
	items.pop(); // the last turn is running: no reply yet
	const id = await chat(items);
	const open = await page(id, OPEN_PAGE_TURNS);
	expect(turnStarts(open.shown)).toBe(OPEN_PAGE_TURNS);
	expect(open.shown.length).toBeGreaterThanOrEqual(OPEN_PAGE_MIN_ITEMS);
	expect(open.hasOlderItems).toBe(true);
	expect(open.shown.at(-1)?.id).toBe("c11");
	expect(open.shown.some((item) => item.id === "u11")).toBe(true);
	const one = await openPageForOwner("alice", id, 1);
	expect(turnStarts(parsed(one?.items))).toBe(OPEN_PAGE_MIN_TURNS);
	const before = await agentSessionPageForOwner("alice", id, {
		turns: 3,
		beforeId: "u8",
	});
	expect(turnStarts(parsed(before?.items))).toBe(3);
});

it("a first page of tiny turns is widened once so it fills the viewport", async () => {
	const tiny = Array.from({ length: 30 }, (_, n) => [
		{ kind: "userMessage", id: `u${n}`, text: "hi" },
		{ kind: "agentMessage", id: `a${n}`, text: "yo" },
	]).flat();
	const id = await chat(tiny);
	const open = await page(id, OPEN_PAGE_TURNS);
	expect(open.shown.length).toBeGreaterThanOrEqual(OPEN_PAGE_MIN_ITEMS);
	expect(turnStarts(open.shown)).toBeGreaterThan(OPEN_PAGE_TURNS);
	expect(open.hasOlderItems).toBe(true);
});
