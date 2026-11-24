import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: async () => undefined,
}));

import { setThreadModel, threadModelSettings } from "./thread-model";

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,harness text,parent_session_id uuid,agent_role text,chat_role text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false);`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261124120000_thread_model_selection.sql",
			"utf8",
		),
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(
	patch: {
		owner?: string;
		turn?: string;
		parent?: string | null;
		role?: string | null;
		chatRole?: string | null;
		harness?: string;
	} = {},
) {
	const id = randomUUID();
	await db.query(
		'insert into agent_session(id,user_id,project_id,harness,parent_session_id,agent_role,chat_role,listed_model_id,turn_status,items) values($1,$2,$3,$4,$5,$6,$7,\'gpt-6-sol\',$8,\'[{"kind":"userMessage","id":"u1","text":"hi"}]\'::jsonb)',
		[
			id,
			patch.owner ?? "alice",
			project,
			patch.harness ?? "codex",
			patch.parent ?? null,
			patch.role ?? null,
			patch.chatRole ?? null,
			patch.turn ?? "idle",
		],
	);
	return id;
}
const change = (sessionId: string, patch: Record<string, unknown> = {}) => ({
	userId: "alice",
	projectId: project,
	sessionId,
	modelId: "claude-code/claude-opus-5-5",
	harness: "api" as const,
	line: "Model changed to Claude Opus 5.5 by the Super agent",
	changeId: "c1",
	...patch,
});
const row = async (id: string) =>
	(
		await db.query<{
			listed_model_id: string;
			harness: string;
			items: { id: string; kind: string; message?: string }[];
		}>("select listed_model_id,harness,items from agent_session where id=$1", [
			id,
		])
	).rows[0];

it("an idle thread: model changes, harness and history stay, one quiet line is added", async () => {
	const id = await chat();
	expect(await setThreadModel(change(id))).toEqual({
		found: true,
		lineWritten: true,
	});
	const after = await row(id);
	expect(after?.listed_model_id).toBe("claude-code/claude-opus-5-5");
	// The next send is what switches the runtime and carries the conversation.
	expect(after?.harness).toBe("codex");
	expect(after?.items.map((item) => item.id)).toEqual([
		"u1",
		`${id}:model-change:c1`,
	]);
	expect(after?.items[1]).toMatchObject({
		kind: "notice",
		message: "Model changed to Claude Opus 5.5 by the Super agent",
	});
});

it("retains an idle selection for future sends, including explicit defaults", async () => {
	const id = await chat();
	await setThreadModel(
		change(id, {
			modelId: "connection|model-z",
			variant: "high",
			speed: "ultrafast",
		}),
	);
	expect(await threadModelSettings("alice", id, "connection|model-z")).toEqual({
		variant: "high",
		speed: "ultrafast",
	});
	expect(await threadModelSettings("alice", id, "other|model-z")).toBeNull();
	expect(await threadModelSettings("bob", id, "connection|model-z")).toBeNull();
	await setThreadModel(
		change(id, { modelId: "connection|model-z", changeId: "c2" }),
	);
	expect(await threadModelSettings("alice", id, "connection|model-z")).toEqual(
		{},
	);
	await db.query("insert into api_turn(id,session_id) values($1,$2)", [
		randomUUID(),
		id,
	]);
	expect(
		await threadModelSettings("alice", id, "connection|model-z"),
	).toBeNull();
});

it("retains Codex fast mode and replaces old API settings", async () => {
	const id = await chat();
	await setThreadModel(change(id, { variant: "high", speed: "ultrafast" }));
	await setThreadModel(
		change(id, {
			modelId: "gpt-example",
			harness: "codex",
			speed: "fast",
			variant: "low",
		}),
	);
	expect(await threadModelSettings("alice", id, "gpt-example")).toEqual({
		variant: "low",
		fast: true,
	});
});

it("a replayed change adds its line once", async () => {
	const id = await chat();
	await setThreadModel(change(id));
	await setThreadModel(change(id));
	expect((await row(id))?.items).toHaveLength(2);
	// A different change is another line.
	await setThreadModel(change(id, { changeId: "c2", modelId: "gpt-6-luna" }));
	expect((await row(id))?.items).toHaveLength(3);
});

it("a running thread: the model changes for its next turn, its transcript is left to the turn", async () => {
	const id = await chat({ turn: "running" });
	expect(await setThreadModel(change(id))).toEqual({
		found: true,
		lineWritten: false,
	});
	const after = await row(id);
	expect(after?.listed_model_id).toBe("claude-code/claude-opus-5-5");
	expect(after?.items).toHaveLength(1);
});

it("messages already waiting move to the new model and lose the old model's settings", async () => {
	const id = await chat();
	const waiting = {
		harnessId: "codex",
		modelId: "gpt-6-sol",
		variant: "xhigh",
		fast: true,
		alternateContext: true,
		item: { id: "q1" },
	};
	await db.query(
		"insert into agent_peer_inbox(id,recipient_id,message,queued_send) values('q1',$1,'m',$2::jsonb),('q2',$1,'m',$3::jsonb)",
		[
			id,
			JSON.stringify(waiting),
			JSON.stringify({ ...waiting, modelId: "keep" }),
		],
	);
	await db.query("update agent_peer_inbox set accepted=true where id='q2'");
	await setThreadModel(change(id, { variant: "high" }));
	const rows = (
		await db.query<{ id: string; queued_send: Record<string, unknown> }>(
			"select id,queued_send from agent_peer_inbox order by id",
		)
	).rows;
	expect(rows[0]?.queued_send).toEqual({
		harnessId: "api",
		modelId: "claude-code/claude-opus-5-5",
		variant: "high",
		item: { id: "q1" },
	});
	// A message a turn already took is left alone.
	expect(rows[1]?.queued_send.modelId).toBe("keep");
});

it("a codex model's fast speed is its fast mode", async () => {
	const id = await chat();
	await db.query(
		'insert into agent_peer_inbox(id,recipient_id,message,queued_send) values(\'q1\',$1,\'m\',\'{"harnessId":"api","modelId":"x","speed":"ultrafast"}\')',
		[id],
	);
	await setThreadModel(
		change(id, { modelId: "gpt-6-luna", harness: "codex", speed: "fast" }),
	);
	const queued = (
		await db.query<{ queued_send: Record<string, unknown> }>(
			"select queued_send from agent_peer_inbox",
		)
	).rows[0]?.queued_send;
	expect(queued).toEqual({
		harnessId: "codex",
		modelId: "gpt-6-luna",
		fast: true,
	});
});

it("refuses another user's thread, Y² itself, a helper chat and another project's thread", async () => {
	const mine = await chat();
	const others = await chat({ owner: "bob" });
	const y2 = await chat({ chatRole: "y2" });
	const helper = await chat({ parent: mine, role: "writer" });
	for (const id of [others, y2, helper])
		expect(await setThreadModel(change(id))).toEqual({
			found: false,
			lineWritten: false,
		});
	expect(
		await setThreadModel(change(mine, { projectId: randomUUID() })),
	).toEqual({ found: false, lineWritten: false });
	for (const id of [others, y2, helper, mine])
		expect((await row(id))?.listed_model_id).toBe("gpt-6-sol");
});
