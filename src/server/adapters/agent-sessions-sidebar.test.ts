import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listSidebarAgentSessions } from "./agent-sessions";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,environment_setup boolean not null default false,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261104120100_agent_session_waiting_on_push",
		"20261104140100_agent_session_waiting_on_push_answered",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(title: string, parent: string | null = null) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,parent_session_id) values($1,'alice',$2,'codex',$3,$4)",
		[id, project, title, parent],
	);
	return id;
}

async function turn(sessionId: string, state: string, createdAt: string) {
	await db.query(
		"insert into api_turn(id,session_id,state,created_at) values($1,$2,$3,$4)",
		[randomUUID(), sessionId, state, createdAt],
	);
}

it("lists when Main's or a helper's active turn started, and nothing for finished turns", async () => {
	const main = await chat("Main runs");
	await turn(main, "running", "2026-10-22T10:00:00Z");
	const parent = await chat("Helper runs");
	const helper = await chat("helper", parent);
	await turn(parent, "completed", "2026-10-22T09:00:00Z");
	await turn(helper, "queued", "2026-10-22T10:05:00Z");
	const idle = await chat("Idle");
	await turn(idle, "completed", "2026-10-22T08:00:00Z");

	const listed = await listSidebarAgentSessions("alice", project);
	const since = Object.fromEntries(
		listed.map((row) => [row.title, row.workingSince]),
	);
	expect(listed.map((row) => row.title).sort()).toEqual([
		"Helper runs",
		"Idle",
		"Main runs",
	]);
	expect(since["Main runs"]).toBe("2026-10-22T10:00:00.000Z");
	expect(since["Helper runs"]).toBe("2026-10-22T10:05:00.000Z");
	expect(since.Idle).toBeNull();
});

it("lists what each chat waits on from the stored column, as the whole history would say, without reading histories", async () => {
	const { chatsFromAgentSessions } = await import("#/domain/agent-session");
	const big = "x".repeat(10_000);
	const histories: Record<string, unknown> = {
		question: [
			{ kind: "userMessage", text: "hi" },
			{ kind: "assistantMessage", text: big },
			{ kind: "userQuestion", question: big },
		],
		answered: [
			{ kind: "userQuestion", question: "?" },
			{ kind: "userMessage", text: "answer" },
			{ kind: "assistantMessage", text: big },
		],
		paused: [
			{ kind: "userMessage", text: "go" },
			{ kind: "modelSwitch", state: "awaitingApproval", detail: big },
		],
		switched: [
			{ kind: "userMessage", text: "go" },
			{ kind: "modelSwitch", state: "approved" },
		],
		planned: [
			{ kind: "userMessage", text: "go" },
			{ kind: "planProposal", plan: "p" },
			{ kind: "agentMessage", text: "see the plan" },
		],
		woken: [
			{ kind: "userMessage", text: "go" },
			{ kind: "secretRequest", name: "X" },
			{ kind: "notice", wake: true, text: "woke" },
			{ kind: "assistantMessage", text: big },
		],
		secret: [
			{ kind: "notice", wake: false, text: "not a turn start" },
			{ kind: "secretRequest", name: "X" },
		],
		push: [
			{ kind: "userMessage", text: "go" },
			{ kind: "pushApproval", id: "card", requestId: "r1", branch: "main" },
			{ kind: "agentMessage", text: "the push waits for approval" },
		],
		pushed: [
			{ kind: "userMessage", text: "go" },
			{ kind: "pushApproval", id: "card", requestId: "r1", branch: "main" },
			{ kind: "agentMessage", text: "the push waits for approval" },
			{
				kind: "notice",
				id: "push-result:r1",
				message: "pushed",
				pushResult: { requestId: "r1", answer: "pushed", detail: "abc1234" },
			},
		],
		running: [{ kind: "userMessage", text: "go" }, { kind: "userQuestion" }],
		empty: [],
		notArray: { kind: "userQuestion" },
	};
	const ids: Record<string, string> = {};
	for (const [title, items] of Object.entries(histories)) {
		ids[title] = await chat(title);
		await db.query("update agent_session set items=$2 where id=$1", [
			ids[title],
			JSON.stringify(items),
		]);
	}
	await db.query(
		"update agent_session set turn_status='failed' where title='answered'",
	);
	await db.query(
		"update agent_session set turn_status='running' where title='running'",
	);
	const listed = await listSidebarAgentSessions("alice", project);
	expect(listed.every((row) => !("items" in row))).toBe(true);
	expect(JSON.stringify(listed).includes(big)).toBe(false);
	const waiting = (rows: readonly { title: string }[]) =>
		Object.fromEntries(
			chatsFromAgentSessions(rows as never).map((row) => [
				row.title,
				row.waitingOn,
			]),
		);
	const full = listed.map(({ waitingOn: _stored, ...row }) => ({
		...row,
		items: histories[row.title],
	}));
	expect(waiting(listed)).toEqual(waiting(full));
	expect(waiting(listed)).toMatchObject({
		question: "question",
		answered: "failed",
		paused: "paused",
		switched: null,
		planned: "plan",
		woken: null,
		secret: "secret",
		push: "push",
		pushed: null,
		running: null,
		empty: null,
		notArray: null,
	});

	// Each later write keeps it: a reply clears the question, a stop fails it.
	await db.query(
		`update agent_session set items=items || '[{"kind":"userMessage","text":"yes"}]'::jsonb where id=$1`,
		[ids.question],
	);
	await db.query("update agent_session set turn_status='failed' where id=$1", [
		ids.running,
	]);
	const after = waiting(await listSidebarAgentSessions("alice", project));
	expect(after).toMatchObject({ question: null, running: "question" });
});

it("finds the chat a page opens as the sidebar list would pick it, without reading its history", async () => {
	const { chatToOpenMetadata } = await import("./agent-sessions");
	const older = await chat("older");
	const latest = await chat("latest");
	const helper = await chat("helper", latest);
	await db.query(
		"update agent_session set updated_at=now()-interval '1 hour' where id=$1",
		[older],
	);
	await db.query(
		"update agent_session set updated_at=now()+interval '1 hour' where id=$1",
		[helper],
	);
	const other = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title) values($1,'alice',$2,'api','elsewhere')",
		[other, randomUUID()],
	);
	const listed = await listSidebarAgentSessions("alice", project);
	const pick = (linked?: string) =>
		(listed.find((row) => row.id === linked) ?? listed[0])?.id;
	for (const linked of [
		undefined,
		older,
		latest,
		helper,
		other,
		randomUUID(),
	]) {
		const found = await chatToOpenMetadata("alice", project, linked);
		expect(found?.id, String(linked)).toBe(pick(linked));
		expect(found && "items" in found).toBeFalsy();
	}
	expect(await chatToOpenMetadata("bob", project, older)).toBeNull();
});

it("never opens the project's setup chat by itself, only when it is linked", async () => {
	const { chatToOpenMetadata } = await import("./agent-sessions");
	const setup = await chat("Set up project");
	await db.query(
		"update agent_session set environment_setup=true, updated_at=now()+interval '1 hour' where id=$1",
		[setup],
	);
	// The new project's only chat is its setup chat: nothing opens.
	expect(await chatToOpenMetadata("alice", project)).toBeNull();
	const task = await chat("Fix login");
	expect((await chatToOpenMetadata("alice", project))?.id).toBe(task);
	expect((await chatToOpenMetadata("alice", project, setup))?.id).toBe(setup);
});

it("marks only opened, never-used chats as unused", async () => {
	const { chatsFromAgentSessions } = await import("#/domain/agent-session");
	const draft = await chat("New session");
	const queued = await chat("New session");
	await turn(queued, "queued", "2026-10-22T10:00:00Z");
	const withItems = await chat("New session");
	await db.query("update agent_session set items=$2 where id=$1", [
		withItems,
		JSON.stringify([{ kind: "userMessage", text: "" }]),
	]);
	const handoff = await chat("Continued from Claude Code");
	await db.query("update agent_session set items=$2 where id=$1", [
		handoff,
		JSON.stringify([{ kind: "handoff", tool: "claude" }]),
	]);
	const listed = chatsFromAgentSessions(
		await listSidebarAgentSessions("alice", project),
	);
	const unused = Object.fromEntries(
		listed.map((row) => [row.id, row.unused === true]),
	);
	expect(unused).toEqual({
		[draft]: true,
		[queued]: false,
		[withItems]: false,
		[handoff]: false,
	});
});
