import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { listSidebarAgentSessions, reusableEmptyChat } from "./agent-sessions";
import {
	chatHoldingMessage,
	chatsWithReleasableHeldSends,
	holdUserMessageForSetup,
	queuedUserMessageItems,
	releaseHeldUserMessages,
	releaseQueuedUserMessage,
	takeNextQueuedUserMessage,
} from "./queued-user-messages";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));

let db: PGlite;
const project = randomUUID();
const workspace = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());
	 create table workspace(id uuid primary key,user_id text,project_id uuid,status text,provider_ref text,template_snapshot_id text);`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	await db.query(
		"insert into workspace(id,user_id,project_id,status) values($1,'alice',$2,'failed')",
		[workspace, project],
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(title: string) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,workspace_id,harness,title) values($1,'alice',$2,$3,'api',$4)",
		[id, project, workspace, title],
	);
	return id;
}

const messageId = "11111111-1111-4111-8111-111111111111";
const send = {
	item: {
		kind: "userMessage" as const,
		id: SessionItemId(messageId),
		text: "Add a login page",
	},
	message: "Add a login page",
	harnessId: "api" as const,
	modelId: "connection|model",
	baseBranch: "develop",
};

it("keeps a held message in its chat, listed in the sidebar as waiting for setup", async () => {
	// Even an untitled chat holding a message is in use, never hidden or reused.
	const held = await chat("New session");
	expect(await holdUserMessageForSetup("alice", held, send)).toBe(true);
	// A replay adds nothing.
	expect(await holdUserMessageForSetup("alice", held, send)).toBe(true);

	const [row] = await listSidebarAgentSessions("alice", project);
	expect(row).toMatchObject({ id: held, waitsForSetup: true });
	expect(row).not.toHaveProperty("unused");
	expect(await reusableEmptyChat("alice", project, "api")).toBeNull();
	expect(await chatHoldingMessage("alice", project, messageId)).toBe(held);

	// A reload (or another device) reads it from the chat's queue.
	expect(await queuedUserMessageItems(held)).toEqual([
		expect.objectContaining({
			id: messageId,
			text: "Add a login page",
			heldForSetup: true,
		}),
	]);
});

it("lists the held send's model on its chat, the one its turn will use", async () => {
	const held = await chat("New session");
	await db.query(
		"update agent_session set listed_model_id='claude-code/claude-haiku-5-5' where id=$1",
		[held],
	);
	await holdUserMessageForSetup("alice", held, {
		...send,
		modelId: "claude-code/claude-opus-5-5",
	});
	const { rows } = await db.query<{ listed_model_id: string }>(
		"select listed_model_id from agent_session where id=$1",
		[held],
	);
	expect(rows[0]?.listed_model_id).toBe("claude-code/claude-opus-5-5");
	await db.query(
		"update workspace set status='ready',template_snapshot_id='snap' where id=$1",
		[workspace],
	);
	await releaseHeldUserMessages(held);
	expect(await takeNextQueuedUserMessage("alice", held)).toMatchObject({
		harnessId: "api",
		modelId: "claude-code/claude-opus-5-5",
	});
});

it("no turn end, Send or step takes a held message; the ready environment releases it once", async () => {
	const held = await chat("Add a login page");
	await holdUserMessageForSetup("alice", held, send);
	expect(await takeNextQueuedUserMessage("alice", held)).toBeNull();
	expect(await releaseQueuedUserMessage("alice", held, messageId)).toEqual({
		status: "missing",
	});
	// The project's setup failed: nothing is releasable.
	expect(await chatsWithReleasableHeldSends(workspace)).toEqual([]);

	await db.query(
		"update workspace set status='ready',template_snapshot_id='snap' where id=$1",
		[workspace],
	);
	expect(await chatsWithReleasableHeldSends(workspace)).toEqual([
		{ userId: "alice", sessionId: held, workspaceId: workspace },
	]);
	expect(await chatsWithReleasableHeldSends()).toHaveLength(1);

	expect(await releaseHeldUserMessages(held)).toBe(true);
	// A second release (the build's job and the sweep both ran) finds nothing.
	expect(await releaseHeldUserMessages(held)).toBe(false);
	const taken = await takeNextQueuedUserMessage("alice", held);
	expect(taken).toMatchObject({
		message: "Add a login page",
		baseBranch: "develop",
		released: true,
		item: { id: messageId },
	});
	expect(taken?.item).not.toHaveProperty("heldForSetup");
	expect(await takeNextQueuedUserMessage("alice", held)).toBeNull();

	const [row] = await listSidebarAgentSessions("alice", project);
	expect(row).not.toHaveProperty("waitsForSetup");
});
