import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	ENVIRONMENT_SETUP_PROMPT,
	initialSetupMessageId,
} from "#/domain/environment-setup";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Two tabs start a new project's setup at the same moment: the database
 * decides, so there is one setup chat and one turn. The chat and queue
 * adapters run against a real database; only the model side is stubbed.
 */
const holder = vi.hoisted(() => ({ query: vi.fn() }));
const model = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn() }));
vi.mock("../adapters/database", () => ({ database: () => holder }));
vi.mock("../adapters/conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));
vi.mock("../adapters/analytics", () => ({
	captureServerAnalytics: vi.fn(async () => {}),
}));
vi.mock("../adapters/background-job-dispatch", () => ({
	backgroundJobId: (key: string) => `job:${key}`,
	dispatchBackgroundJob: vi.fn(async () => true),
}));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: model.send,
	readHarnessWorkspaceSession: model.read,
	stopHarnessWorkspaceTurn: vi.fn(),
}));
vi.mock("./message-attachments", () => ({
	storeMessageAttachments: vi.fn(async () => []),
}));
vi.mock("./agent-mentions", () => ({
	mentionNoteFor: vi.fn(async () => null),
}));

const { sendComposerMessage } = await import("./queued-user-messages");

let db: PGlite;
const project = randomUUID();
const workspace = randomUUID();

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,environment_setup boolean not null default false,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());
	 create table workspace(id uuid primary key,user_id text,project_id uuid,status text,provider_ref text,template_snapshot_id text,template_source_ref text,template_source_sha text,error_message text,updated_at timestamptz default now(),created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	await db.query(
		"insert into workspace(id,user_id,project_id,status) values($1,'alice',$2,'cloning')",
		[workspace, project],
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	model.send.mockReset();
	model.read.mockReset();
	model.read.mockImplementation((scope: { sessionId?: string }) =>
		Effect.succeed({
			agentSessionId: scope.sessionId ?? null,
			items: [],
			turnStatus: "idle",
			connection: { status: "authenticated" },
		}),
	);
	model.send.mockImplementation(
		(_machines: unknown, scope: { sessionId?: string }) =>
			Effect.succeed({
				agentSessionId: scope.sessionId ?? null,
				items: [],
				turnStatus: "running",
				connection: { status: "authenticated" },
			}),
	);
});
afterEach(() => db.close());

const start = () =>
	Effect.runPromise(
		sendComposerMessage(
			{} as WorkspaceMachines,
			{
				userId: "alice",
				projectId: project,
				harnessId: "api",
				createNew: true,
			},
			{
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: "connection|model",
				idempotencyKey: initialSetupMessageId(project),
				environmentSetup: true,
			},
		),
	);

it("two tabs starting a new project's setup together get one chat and one held request", async () => {
	const [first, second] = await Promise.all([start(), start()]);
	const chats = await db.query<{ id: string; environment_setup: boolean }>(
		"select id, environment_setup from agent_session where project_id=$1",
		[project],
	);
	expect(chats.rows).toHaveLength(1);
	expect(chats.rows[0].environment_setup).toBe(true);
	expect(first.agentSessionId).toBe(chats.rows[0].id);
	expect(second.agentSessionId).toBe(chats.rows[0].id);
	const held = await db.query("select recipient_id from agent_peer_inbox");
	expect(held.rows).toEqual([{ recipient_id: chats.rows[0].id }]);
	// A third start (a reload) opens the same chat and adds nothing.
	expect((await start()).agentSessionId).toBe(chats.rows[0].id);
	expect((await db.query("select 1 from agent_session")).rows).toHaveLength(1);
	expect((await db.query("select 1 from agent_peer_inbox")).rows).toHaveLength(
		1,
	);
	expect(model.send).not.toHaveBeenCalled();
});

it("with the environment already ready, two simultaneous starts start one turn", async () => {
	await db.query(
		"update workspace set status='ready',provider_ref='vm',template_snapshot_id='snap' where id=$1",
		[workspace],
	);
	const [first, second] = await Promise.all([start(), start()]);
	expect((await db.query("select 1 from agent_session")).rows).toHaveLength(1);
	expect(model.send).toHaveBeenCalledOnce();
	expect(first.agentSessionId).toBe(second.agentSessionId);
});

it("takes over a setup chat whose start died before sending", async () => {
	const { initialSetupChatId } = await import("../adapters/agent-sessions");
	await db.query(
		"insert into agent_session(id,user_id,project_id,workspace_id,harness,title,created_at) values($1,'alice',$2,$3,'api','Set up project',now()-interval '2 minutes')",
		[initialSetupChatId(project), project, workspace],
	);
	await start();
	expect((await db.query("select 1 from agent_session")).rows).toHaveLength(1);
	expect((await db.query("select 1 from agent_peer_inbox")).rows).toHaveLength(
		1,
	);
});
