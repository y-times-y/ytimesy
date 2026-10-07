import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { recoverConversation } from "../services/conversation-recovery";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	conversationPoint,
	recordConversationPoint,
	recoveredConversation,
	saveRecoveredConversation,
} from "./conversation-recovery";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
let db: PGlite;
const session = randomUUID(),
	project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,title text,listed_model_id text,status text,turn_status text,task_access text,selected_branch text,working_branch text,task_branch text,parent_session_id uuid,provider_ref text,task_placement text,items jsonb default '[]',task_summary text,task_review_state text,updated_at timestamptz default now());
 create table agent_task_command_receipt(parent_session_id uuid references agent_session(id),request_id text,status text,response jsonb,created_at timestamptz default now(),completed_at timestamptz,updated_at timestamptz default now(),primary key(parent_session_id,request_id));
 create table api_turn(session_id uuid,user_id text,messages jsonb,model_id text,connection_revision text,created_at timestamptz default now());`);
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,turn_status,items)values($1,'alice',$2,'api','Original','idle','[]')",
		[session, project],
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	holder.connect.mockResolvedValue({ query: holder.query, release() {} });
	await recordConversationPoint(holder, {
		userId: "alice",
		sessionId: session,
		items: [
			{ kind: "userMessage", id: SessionItemId("first"), text: "Implement" },
		],
		messages: [{ role: "user", content: "Implement" }],
		modelId: "model",
		routeId: "route",
		revision: "revision",
	});
	await db.query("update agent_session set items=$2 where id=$1", [
		session,
		JSON.stringify([
			{ kind: "userMessage", id: "first", text: "Implement" },
			{ kind: "agentMessage", id: "answer", text: "Done" },
		]),
	]);
});
afterEach(() => db.close());

it("restores both public and actual history without resurrecting an incompatible model route", async () => {
	const point = await conversationPoint("alice", session, "first");
	if (!point) throw new Error("Missing point");
	expect(await conversationPoint("bob", session, "first")).toBeNull();
	await saveRecoveredConversation(holder, "alice", session, point);
	expect(
		(
			await db.query<{ items: unknown }>(
				"select items from agent_session where id=$1",
				[session],
			)
		).rows[0].items,
	).toEqual([]);
	expect(
		await recoveredConversation("alice", session, "model", "revision"),
	).toEqual({ messages: [] });
	expect(
		await recoveredConversation("alice", session, "other", "revision"),
	).toEqual({ messages: null });
	await expect(
		recordConversationPoint(holder, {
			userId: "alice",
			sessionId: session,
			items: [
				{ kind: "userMessage", id: SessionItemId("first"), text: "Implement" },
				{ kind: "userMessage", id: SessionItemId("stale"), text: "Continue" },
			],
			messages: [{ role: "user", content: "Continue" }],
			modelId: "model",
			routeId: "route",
			revision: "revision",
		}),
	).rejects.toThrow("restored");
});

it("forks into independent session ancestry and retains the original conversation", async () => {
	const recovered = await recoverConversation(
		{} as WorkspaceMachines,
		"alice",
		{
			projectId: project,
			sessionId: session,
			messageId: "first",
			mode: "fork",
		},
	);
	expect(recovered.id).not.toBe(session);
	expect(recovered.prompt).toBe("Implement");
	const fork = (
		await db.query<{
			items: unknown;
			parent_session_id: unknown;
			provider_ref: unknown;
		}>("select * from agent_session where id=$1", [recovered.id])
	).rows[0];
	expect(fork.items).toEqual([]);
	expect(fork.parent_session_id).toBeNull();
	expect(fork.provider_ref).toBeNull();
	expect(
		(
			await db.query<{ items: unknown[] }>(
				"select items from agent_session where id=$1",
				[session],
			)
		).rows[0].items,
	).toHaveLength(2);
});

it("rejects other owners, running turns, active children, and code-less recovery", async () => {
	const input = {
		projectId: project,
		sessionId: session,
		messageId: "first",
		mode: "conversation" as const,
	};
	await expect(
		recoverConversation({} as WorkspaceMachines, "bob", input),
	).rejects.toThrow();
	await db.query("update agent_session set turn_status='running' where id=$1", [
		session,
	]);
	await expect(
		recoverConversation({} as WorkspaceMachines, "alice", input),
	).rejects.toThrow("active turn");
	await db.query("update agent_session set turn_status='idle' where id=$1", [
		session,
	]);
	await expect(
		recoverConversation({} as WorkspaceMachines, "alice", {
			...input,
			mode: "code",
		}),
	).rejects.toThrow("checkpoint");
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,turn_status)values($1,'alice',$2,'running')",
		[randomUUID(), session],
	);
	await expect(
		recoverConversation({} as WorkspaceMachines, "alice", input),
	).rejects.toThrow("child tasks");
});
