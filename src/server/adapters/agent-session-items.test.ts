import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionListedModelIsBlocked } from "#/domain/listed-model";
import type { SessionItem } from "#/domain/session-item";
import { transcriptPagesForOwner } from "./agent-session-items";
import {
	agentSessionPageForOwner,
	childAgentSession,
	descendantTokenUsageItemsForOwner,
	listAgentSessions,
	listedModelBlockItemsForOwner,
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

function turnItems(n: number, reply = `reply ${n}`): SessionItem[] {
	return [
		{
			kind: "userMessage",
			id: `t${n}` as never,
			text: `ask ${n}`,
			apiUsage: {
				inputTokens: 10,
				outputTokens: 1,
				uncachedInputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
		{
			kind: "commandExecution",
			id: `t${n}-cmd` as never,
			command: "ls",
			cwd: null,
			status: "completed",
			output: "x".repeat(400),
			exitCode: 0,
		},
		{ kind: "agentMessage", id: `t${n}-reply` as never, text: reply },
	];
}

async function chat(
	items: readonly unknown[],
	fields: { user?: string; parent?: string; model?: string } = {},
) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items,parent_session_id,listed_model_id) values($1,$2,$3,'api','chat',$4::jsonb,$5,$6)",
		[
			id,
			fields.user ?? "alice",
			project,
			JSON.stringify(items),
			fields.parent ?? null,
			fields.model ?? null,
		],
	);
	return id;
}

const ids = (items: unknown) =>
	(items as SessionItem[]).map((item) => item.id as string);

it("reads each helper's last turns, where they start, and pages before a stored position", async () => {
	const items = Array.from({ length: 6 }, (_, n) => turnItems(n)).flat();
	const a = await chat(items);
	const b = await chat(turnItems(0));
	const other = await chat(items, { user: "mallory" });
	const limits = { turns: 2, bytes: 1_000_000, items: 1000 };

	const pages = await transcriptPagesForOwner("alice", [a, b, other], limits);
	// Another user's chat is never read.
	expect([...pages.keys()].sort()).toEqual([a, b].sort());
	expect(pages.get(a)).toMatchObject({ first: 12 });
	expect(ids(pages.get(a)?.items)).toEqual(ids(items.slice(12)));
	// The same page the chat's own reader cuts.
	const reference = await agentSessionPageForOwner("alice", a, { turns: 2 });
	expect(ids(pages.get(a)?.items)).toEqual(ids(reference?.items));
	expect(pages.get(b)).toMatchObject({ first: 0 });

	const older = await transcriptPagesForOwner("alice", [a], {
		...limits,
		before: 12,
	});
	expect(older.get(a)?.first).toBe(6);
	expect(ids(older.get(a)?.items)).toEqual(ids(items.slice(6, 12)));
	const oldest = await transcriptPagesForOwner("alice", [a], {
		...limits,
		before: 6,
	});
	expect(oldest.get(a)?.first).toBe(0);
});

it("caps a page by bytes and items, the newest item always in", async () => {
	const items = Array.from({ length: 3 }, (_, n) => turnItems(n)).flat();
	const a = await chat(items);
	const byItems = await transcriptPagesForOwner("alice", [a], {
		turns: 3,
		bytes: 1_000_000,
		items: 4,
	});
	expect(byItems.get(a)?.first).toBe(5);
	expect(ids(byItems.get(a)?.items)).toEqual(ids(items.slice(5)));
	const byBytes = await transcriptPagesForOwner("alice", [a], {
		turns: 3,
		bytes: 1,
		items: 100,
	});
	expect(ids(byBytes.get(a)?.items)).toEqual(["t2-reply"]);
	expect(byBytes.get(a)?.first).toBe(8);
});

it("reads only what the blocked-model scan reads: errors and replies from the last reply on", async () => {
	const blocked = [
		...turnItems(0),
		...turnItems(1, "  "),
		{
			kind: "error",
			id: "e",
			message: "[user_blocked] access has been restricted",
		},
	];
	const fine = [
		{ kind: "error", id: "e0", message: "[user_blocked] once" },
		...turnItems(0),
	];
	const a = await chat(blocked, { model: "m" });
	const b = await chat(fine, { model: "m" });
	const read = await listedModelBlockItemsForOwner("alice", [a, b]);
	expect(ids(read.get(a))).toEqual(["t0-reply", "t1-reply", "e"]);
	expect(ids(read.get(b))).toEqual(["t0-reply"]);
	// The same answer as the scan over the whole transcript.
	for (const [id, whole] of [
		[a, blocked],
		[b, fine],
	] as const)
		expect(sessionListedModelIsBlocked("m", read.get(id))).toBe(
			sessionListedModelIsBlocked("m", whole),
		);
});

it("lists chats and a parent's child without their transcripts", async () => {
	const root = await chat(turnItems(0));
	const kid = await chat(turnItems(1), { parent: root });
	const listed = await listAgentSessions("alice", project);
	expect(listed.map((session) => session.id)).toEqual([root]);
	expect(listed[0]).not.toHaveProperty("items");
	const child = await childAgentSession("alice", root);
	expect(child?.id).toBe(kid);
	expect(child).not.toHaveProperty("items");
});

it("reads descendants' token use from their turns' starts only", async () => {
	const root = await chat([]);
	const kid = await chat(turnItems(0), { parent: root, model: "m" });
	const grandkid = await chat(turnItems(1), { parent: kid });
	const usage = await descendantTokenUsageItemsForOwner("alice", root);
	expect(usage.map((entry) => entry.id).sort()).toEqual([kid, grandkid].sort());
	const kidUsage = usage.find((entry) => entry.id === kid);
	expect(kidUsage).toMatchObject({ listedModelId: "m" });
	expect(ids(kidUsage?.usageItems)).toEqual(["t0"]);
	expect(kidUsage).not.toHaveProperty("items");
});

it("reads background commands as slim records for the agents list, whole items otherwise", async () => {
	const big = "x".repeat(50_000);
	const running = {
		kind: "dynamicToolCall",
		id: "call-1",
		tool: "bash",
		input: big,
		output: big,
		status: "completed",
		background: { id: "one", label: "run one", startedAt: 5 },
	};
	const exited = {
		...running,
		id: "call-2",
		background: {
			id: "two",
			label: "run two",
			startedAt: 6,
			exitCode: 0,
			endedAt: 9,
		},
	};
	const id = await chat([
		running,
		{ kind: "agentMessage", id: "m" as never, text: "hi" },
		exited,
	]);
	const { backgroundCommandItemsForOwner } = await import("./agent-sessions");
	const slim = await backgroundCommandItemsForOwner("alice", [id], {
		records: true,
	});
	expect(slim.get(id)).toEqual([
		{
			kind: "dynamicToolCall",
			background: { id: "one", label: "run one", startedAt: 5 },
		},
		{
			kind: "dynamicToolCall",
			background: { id: "two", label: "run two", startedAt: 6, exitCode: 0 },
		},
	]);
	const whole = await backgroundCommandItemsForOwner("alice", [id]);
	expect(whole.get(id)).toEqual([running, exited]);
});
