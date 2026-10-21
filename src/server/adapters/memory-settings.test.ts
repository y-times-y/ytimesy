import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	lastMemoryReview,
	pendingMemorySaves,
	recentUnsavedMessages,
} from "./memory-settings";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,title text,items jsonb not null default '[]',updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,updated_at timestamptz default now());
	 create table memory_model_usage(id uuid primary key,user_id text,kind text,session_id uuid,outcome text,created_at timestamptz default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
});
afterEach(() => db.close());

async function chat(input: {
	items: unknown[];
	user?: string;
	state?: string;
	minutesAgo?: number;
	parent?: string;
}) {
	const id = randomUUID();
	const at = `now()-interval '${input.minutesAgo ?? 0} minutes'`;
	await db.query(
		`insert into agent_session(id,user_id,parent_session_id,title,items,updated_at) values($1,$2,$3,'Chat',$4,${at})`,
		[id, input.user ?? "u1", input.parent ?? null, JSON.stringify(input.items)],
	);
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,updated_at) values($1,$2,$3,$4,${at})`,
		[randomUUID(), id, input.user ?? "u1", input.state ?? "completed"],
	);
	return id;
}
const said = (text: string) => ({
	kind: "userMessage",
	id: randomUUID(),
	text,
});

it("returns other chats' latest messages that memory has not saved yet", async () => {
	const current = await chat({ items: [said("this chat")] });
	const fresh = await chat({
		items: [said("old message"), said("New JSON files use 4 spaces")],
	});
	await chat({
		items: [
			said("Use pnpm"),
			{
				kind: "memorySave",
				id: "s",
				lines: [{ path: "t.md", text: "Uses pnpm" }],
			},
		],
	});
	const nothing = await chat({ items: [said("Fix the flaky test")] });
	await db.query(
		"insert into memory_model_usage(id,user_id,kind,session_id,outcome) values($1,'u1','save',$2,'completed:nothing-new')",
		[randomUUID(), nothing],
	);
	await chat({ items: [said("an hour ago")], minutesAgo: 60 });
	await chat({ items: [said("someone else")], user: "u2" });
	await chat({ items: [said("a child task")], parent: fresh });
	await chat({ items: [said("failed")], state: "failed" });
	expect(await recentUnsavedMessages("u1", current, 600)).toEqual([
		{
			sessionId: fresh,
			title: "Chat",
			text: "New JSON files use 4 spaces",
			at: expect.any(Date),
		},
	]);
});

it("counts a chat from when its message was sent: queued and running turns too", async () => {
	const current = await chat({ items: [said("this chat")] });
	// Its turn row may not read completed yet when the next chat starts.
	const running = await chat({
		items: [said("Every log line in orders.py starts with [orders]")],
		state: "running",
	});
	const queued = await chat({
		items: [said("JSON files use 4-space indentation")],
		state: "queued",
		minutesAgo: 30,
	});
	await chat({ items: [said("long done")], minutesAgo: 30 });
	const rows = await recentUnsavedMessages("u1", current, 600);
	expect(rows.map((row) => row.sessionId).sort()).toEqual(
		[running, queued].sort(),
	);
});

it("counts other chats whose last completed turn has no save-hook run yet", async () => {
	const current = await chat({ items: [said("this chat")] });
	expect(await pendingMemorySaves("u1", current, 120)).toBe(0);
	const pending = await chat({ items: [said("New IDs use ULIDs")] });
	const saved = await chat({ items: [said("Use pnpm")] });
	await db.query(
		"insert into memory_model_usage(id,user_id,kind,session_id,outcome) values($1,'u1','save',$2,'completed')",
		[randomUUID(), saved],
	);
	// Not waited on: running, failed, long ago, a child task, another user.
	await chat({ items: [said("still working")], state: "running" });
	await chat({ items: [said("failed")], state: "failed" });
	await chat({ items: [said("long done")], minutesAgo: 30 });
	await chat({ items: [said("a child task")], parent: pending });
	await chat({ items: [said("someone else")], user: "u2" });
	expect(await pendingMemorySaves("u1", current, 120)).toBe(1);
	// A save recorded before the turn ended was the previous turn's.
	await db.query(
		"insert into memory_model_usage(id,user_id,kind,session_id,outcome,created_at) values($1,'u1','save',$2,'completed',now()-interval '1 minute')",
		[randomUUID(), pending],
	);
	expect(await pendingMemorySaves("u1", current, 120)).toBe(1);
	await db.query(
		"insert into memory_model_usage(id,user_id,kind,session_id,outcome,created_at) values($1,'u1','save',$2,'completed:nothing-new',now()+interval '1 second')",
		[randomUUID(), pending],
	);
	expect(await pendingMemorySaves("u1", current, 120)).toBe(0);
	// The asking chat is never counted; from there, "current" is the one pending.
	expect(await pendingMemorySaves("u1", pending, 120)).toBe(1);
});

it("finds the last dream that reviewed the whole repo", async () => {
	expect(await lastMemoryReview("u1")).toBeNull();
	const add = (user: string, kind: string, outcome: string, at: string) =>
		db.query(
			"insert into memory_model_usage(id,user_id,kind,outcome,created_at) values($1,$2,$3,$4,$5)",
			[randomUUID(), user, kind, outcome, at],
		);
	await add("u1", "dream", "completed:review", "2026-10-01T00:00:00Z");
	await add("u1", "dream", "completed", "2026-10-09T00:00:00Z");
	await add("u1", "save", "completed", "2026-10-10T00:00:00Z");
	await add("u2", "dream", "completed:review", "2026-10-11T00:00:00Z");
	expect(await lastMemoryReview("u1")).toEqual(
		new Date("2026-10-01T00:00:00Z"),
	);
});
