import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	agentSessionPageForOwner,
	sessionItemDetailForOwner,
} from "./agent-sessions";
import {
	LATEST_PAGE_ITEMS_SQL,
	latestPageJoin,
	latestPageRowsSinceSql,
	PAGE_TEXT_CAP,
} from "./transcript-page-sql";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,thread_number int,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
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
afterEach(() => db.close());

const HUGE_HTML = `<html>${"<p>canvas</p>".repeat(1500)}</html>`;
const BIG_TEXT = `${"line of command output\n".repeat(500)}exit 0`;
const REPLY = `${"a long reply sentence. ".repeat(100)}THE END`;

const items = [
	{ kind: "userMessage", id: "u1", text: "run it" },
	{
		kind: "dynamicToolCall",
		id: "plain",
		tool: "execute_command",
		input: JSON.stringify({ command: "pnpm test" }),
		output: BIG_TEXT,
		status: "completed",
	},
	{
		kind: "dynamicToolCall",
		id: "lean",
		tool: "execute_command",
		input: JSON.stringify({ command: "pnpm build" }),
		output: JSON.stringify({
			status: 0,
			outputPath: "/tmp/o",
			output: BIG_TEXT,
		}),
		status: "completed",
	},
	{
		kind: "dynamicToolCall",
		id: "write",
		tool: "write_file",
		// content stays whole: the collapsed card counts its lines.
		input: JSON.stringify({ path: "a.ts", content: BIG_TEXT, note: BIG_TEXT }),
		output: "ok",
		status: "completed",
	},
	{
		kind: "dynamicToolCall",
		id: "program",
		tool: "run_code",
		input: JSON.stringify({ code: BIG_TEXT }),
		output: JSON.stringify({ calls: [], note: BIG_TEXT }),
		status: "completed",
	},
	{
		kind: "dynamicToolCall",
		id: "small",
		tool: "read",
		input: "{}",
		output: "short",
		status: "completed",
	},
	{ kind: "canvas", id: "c1", title: "Mock", revision: 1, html: HUGE_HTML },
	{ kind: "agentMessage", id: "a1", text: REPLY },
];

async function chat(rows: readonly unknown[] = items) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,'alice',$2,'codex','chat',$3::jsonb)",
		[id, randomUUID(), JSON.stringify(rows)],
	);
	return id;
}

type Out = Record<string, unknown> & { id: string };
const byId = (page: unknown) =>
	Object.fromEntries((page as Out[]).map((item) => [item.id, item]));

it("cuts long tool text and leaves canvas html out of a page, keeping messages whole", async () => {
	const id = await chat();
	const page = await agentSessionPageForOwner("alice", id, { turns: 6 });
	const got = byId(page?.items);
	const original = byId(items);
	const bytes = (value: unknown) => JSON.stringify(value).length;

	// Plain-text output: head and tail (the exit line) stay.
	const plain = got.plain as Out & { output: string };
	expect(plain.truncated).toBe(true);
	expect(plain.detailSession).toBe(id);
	expect(plain.output.length).toBeLessThan(PAGE_TEXT_CAP + 200);
	expect(plain.output.endsWith("exit 0")).toBe(true);
	expect(plain.output).toContain("characters omitted");

	// A JSON record keeps its fields; only its long `output` text is cut.
	const lean = got.lean as Out & { output: string };
	const record = JSON.parse(lean.output);
	expect(record).toMatchObject({ status: 0, outputPath: "/tmp/o" });
	expect(record.output.length).toBeLessThan(PAGE_TEXT_CAP + 200);
	expect(lean.truncated).toBe(true);

	// A write keeps `content` (its +lines count) and cuts other long fields.
	const write = got.write as Out & { input: string };
	const input = JSON.parse(write.input);
	expect(input.content).toBe(BIG_TEXT);
	expect(input.note.length).toBeLessThan(PAGE_TEXT_CAP + 200);
	expect(write.truncated).toBe(true);

	// Structured programs and small calls are untouched.
	expect(got.program).toEqual(original.program);
	expect(got.small).toEqual(original.small);

	// Canvas html never travels in a page.
	const canvas = got.c1 as Out;
	expect(canvas).toMatchObject({
		html: null,
		htmlOmitted: true,
		detailSession: id,
	});
	expect(JSON.stringify(page?.items)).not.toContain("canvas</p>");

	// Messages stay whole.
	expect(got.a1).toEqual(original.a1);
	expect(got.u1).toEqual(original.u1);

	expect(bytes(page?.items)).toBeLessThan(bytes(items) / 2);
});

it("returns a cut tool call and a canvas whole by id, for the owner only", async () => {
	const id = await chat();
	const plain = (await sessionItemDetailForOwner("alice", id, "plain")) as Out;
	expect(plain.output).toBe(BIG_TEXT);
	expect(plain.truncated).toBeUndefined();
	const canvas = (await sessionItemDetailForOwner("alice", id, "c1")) as Out;
	expect(canvas.html).toBe(HUGE_HTML);
	expect(await sessionItemDetailForOwner("bob", id, "plain")).toBeNull();
	// Messages are not served by the detail read.
	expect(await sessionItemDetailForOwner("alice", id, "a1")).toBeNull();
});

it("regression guard: the snapshot and delta SQL carry no canvas html or uncapped tool output", async () => {
	const id = await chat();
	const snapshot = await db.query<{ items: Out[] }>(
		`select ${LATEST_PAGE_ITEMS_SQL} as items from agent_session s ${latestPageJoin(6)} where s.id=$1`,
		[id],
	);
	const delta = await db.query<{ rows: { item: Out }[] }>(
		`select ${latestPageRowsSinceSql("(-1)")} as rows from agent_session s ${latestPageJoin(6)} where s.id=$1`,
		[id],
	);
	for (const stored of [
		snapshot.rows[0]?.items ?? [],
		(delta.rows[0]?.rows ?? []).map((row) => row.item),
	]) {
		const text = JSON.stringify(stored);
		expect(text).not.toContain("canvas</p>");
		const got = byId(stored);
		expect((got.plain as Out & { output: string }).output.length).toBeLessThan(
			PAGE_TEXT_CAP + 200,
		);
		expect(got.a1).toEqual(byId(items).a1);
	}
});

it("a delta carries only the rows written after the held revision, none when unchanged", async () => {
	const id = await chat();
	const rev = async () =>
		(
			await db.query<{ r: string }>(
				"select items_rev::text r from agent_session where id=$1",
				[id],
			)
		).rows[0]?.r as string;
	const since = async (held: string) =>
		(
			await db.query<{ rows: { position: number; item: Out }[] }>(
				`select ${latestPageRowsSinceSql("$2::bigint")} as rows from agent_session s ${latestPageJoin(6)} where s.id=$1`,
				[id, held],
			)
		).rows[0]?.rows ?? [];
	const held = await rev();
	expect(await since(held)).toEqual([]);
	await db.query(
		"update agent_session set items=items||$2::jsonb where id=$1",
		[id, JSON.stringify([{ kind: "agentMessage", id: "a2", text: "more" }])],
	);
	const changed = await since(held);
	expect(changed.map((row) => row.item.id)).toEqual(["a2"]);
	expect(await since(await rev())).toEqual([]);
});
