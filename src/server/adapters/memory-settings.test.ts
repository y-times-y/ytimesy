import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	lastMemoryReview,
	memoryChat,
	memoryChatsSince,
	memoryProject,
	memoryProjects,
	memoryRecalls,
	pendingMemorySaves,
	recentUnsavedMessages,
	recordMemoryRecalls,
} from "./memory-settings";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,project_id uuid,title text,items jsonb not null default '[]',updated_at timestamptz default now());
	 create table project(id uuid primary key,user_id text,repository_id bigint,full_name text,name text,created_at timestamptz default now());
	 create table project_repository(project_id uuid,repository_id bigint,position integer);
	 create table memory_line_recall(user_id text not null,line_hash text not null,first_recalled_at timestamptz not null default now(),recalled_at timestamptz not null default now(),recall_count integer not null default 1,primary key(user_id,line_hash));
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
	project?: string;
}) {
	const id = randomUUID();
	const at = `now()-interval '${input.minutesAgo ?? 0} minutes'`;
	await db.query(
		`insert into agent_session(id,user_id,parent_session_id,project_id,title,items,updated_at) values($1,$2,$3,$4,'Chat',$5,${at})`,
		[
			id,
			input.user ?? "u1",
			input.parent ?? null,
			input.project ?? null,
			JSON.stringify(input.items),
		],
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
	expect(await recentUnsavedMessages("u1", current, 600, null)).toEqual([
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
	const rows = await recentUnsavedMessages("u1", current, 600, null);
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

it("returns only recent messages of the asking chat's own project", async () => {
	const web = randomUUID();
	const api = randomUUID();
	const current = await chat({ items: [said("this chat")], project: web });
	const same = await chat({
		items: [said("New JSON files use 4 spaces")],
		project: web,
	});
	await chat({ items: [said("Use Go modules")], project: api });
	await chat({ items: [said("No project here")] });
	expect(
		(await recentUnsavedMessages("u1", current, 600, web)).map(
			(row) => row.sessionId,
		),
	).toEqual([same]);
	expect(
		(await recentUnsavedMessages("u1", current, 600, null)).map(
			(row) => row.text,
		),
	).toEqual(["No project here"]);
});

it("reads a project with its repository ids, and a chat with its project", async () => {
	const id = randomUUID();
	await db.query(
		"insert into project(id,user_id,repository_id,full_name,name) values($1,'u1',7,'acme/web','Web')",
		[id],
	);
	await db.query(
		"insert into project_repository(project_id,repository_id,position) values($1,7,0),($1,9,1)",
		[id],
	);
	const solo = randomUUID();
	await db.query(
		"insert into project(id,user_id,repository_id,full_name,name) values($1,'u1',11,'acme/api',null)",
		[solo],
	);
	expect(await memoryProject("u1", id)).toEqual({
		fullName: "acme/web",
		name: "Web",
		repositoryIds: [7, 9],
	});
	expect(await memoryProject("u2", id)).toBeNull();
	// A project without repository rows falls back to its primary repository.
	expect((await memoryProjects("u1")).map((row) => row.repositoryIds)).toEqual([
		[7, 9],
		[11],
	]);
	const session = await chat({ items: [said("hi there")], project: id });
	expect((await memoryChat("u1", session))?.projectRef).toEqual({
		fullName: "acme/web",
		name: "Web",
		repositoryIds: [7, 9],
	});
});

it("dreams from projected fields without transferring tool bodies or changing its input", async () => {
	const { dreamChat } = await import("../services/memory-jobs");
	await db.exec("create table harness_evaluation_run(root_session_id uuid)");
	const since = new Date("2026-11-12T00:00:00Z");
	const earlier = {
		...said("old choice"),
		timing: { startedAt: since.getTime() - 1000 },
	};
	const recent = {
		...said("use tabs in the new parser"),
		timing: { startedAt: since.getTime() + 1000 },
	};
	const items = [
		earlier,
		{
			kind: "commandExecution",
			id: "older-failure",
			command: "old-check",
			status: "failed",
			exitCode: 2,
			output: "old failure",
		},
		{ kind: "agentMessage", id: "old-answer", text: "old answer" },
		recent,
		{
			kind: "dynamicToolCall",
			id: "large-unused",
			input: "unused input".repeat(20000),
			output: "unused output".repeat(20000),
		},
		{
			kind: "agentMessage",
			id: "comment",
			phase: "commentary",
			text: "unused commentary".repeat(10000),
		},
		...Array.from({ length: 7 }, (_, index) => ({
			kind: "commandExecution",
			id: `failure-${index}`,
			command: `new-check-${index}`,
			status: "failed",
			exitCode: index + 1,
			output: `${"omitted prefix".repeat(3000)}${"🧪".repeat(400)}tail-${index}`,
		})),
		{
			kind: "commandExecution",
			id: "success",
			command: "passing-check",
			status: "completed",
			exitCode: 0,
			output: "unused successful output".repeat(10000),
		},
		{
			kind: "commandExecution",
			id: "running",
			command: "unfinished-check",
			status: "inProgress",
			exitCode: null,
			output: "unused running output".repeat(10000),
		},
		{ kind: "agentMessage", id: "first-answer", text: "intermediate answer" },
		{ kind: "agentMessage", id: "last-answer", text: "the final answer" },
	];
	const id = await chat({ items });
	await chat({ items, user: "u2" });
	await chat({ items, parent: id });
	await chat({ items, state: "running" });
	// Both readers keep their existing timestamps (session vs latest turn).
	// Align the fixture so the dream-input comparison also checks the date.
	await db.query(
		"update api_turn set updated_at=(select updated_at from agent_session where id=$1) where session_id=$1",
		[id],
	);
	const [projected] = await memoryChatsSince("u1", since);
	expect(projected?.id).toBe(id);
	const complete = await memoryChat("u1", id);
	if (!complete || !projected) throw new Error("Missing chat");
	for (const boundary of [null, since])
		for (const failures of [false, true])
			expect(
				dreamChat(projected, boundary, "https://example.test", failures),
			).toEqual(
				dreamChat(complete, boundary, "https://example.test", failures),
			);
	expect(JSON.stringify(projected).length).toBeLessThan(
		JSON.stringify(complete).length / 20,
	);
	expect(complete.items).toHaveLength(items.length);
	expect(await memoryChatsSince("nobody", since)).toEqual([]);
	await db.query("update agent_session set items='null'::jsonb where id=$1", [
		id,
	]);
	expect((await memoryChatsSince("u1", since))[0]?.items).toEqual([]);
});

it("records recalls by normalized text and reads when each line was last used", async () => {
	expect(await memoryRecalls("u1", ["Uses pnpm"])).toEqual({
		recalled: new Map(),
		since: null,
	});
	await recordMemoryRecalls("u1", [
		"Uses  pnpm",
		"Uses pnpm",
		"Deploys on Fly",
	]);
	await recordMemoryRecalls("u1", ["uses pnpm"]);
	const { recalled, since } = await memoryRecalls("u1", [
		"Uses pnpm",
		"Never used",
	]);
	const today = new Date().toISOString().slice(0, 10);
	expect([...recalled]).toEqual([["uses pnpm", today]]);
	expect(since).toBe(today);
	const counts = await db.query<{ recall_count: number }>(
		"select recall_count from memory_line_recall order by recall_count desc",
	);
	expect(counts.rows.map((row) => row.recall_count)).toEqual([2, 1]);
	expect((await memoryRecalls("u2", ["Uses pnpm"])).since).toBeNull();
});
