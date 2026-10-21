import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	ownsWritableCheckout,
	recoverConversation,
} from "../services/conversation-recovery";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	conversationPoint,
	recordConversationPoint,
	recoveredConversation,
	saveRecoveredConversation,
} from "./conversation-recovery";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
const code = vi.hoisted(() => ({
	capture: vi.fn(),
	restore: vi.fn(),
}));
vi.mock("../services/conversation-code-checkpoint", () => ({
	captureConversationCode: code.capture,
	restoreConversationCode: code.restore,
}));
const coordinate = vi.hoisted(() => vi.fn(async (_action: string) => true));
vi.mock("./conversation-turn-control", () => ({
	coordinateConversationTurn: coordinate,
}));
vi.mock("./agent-sessions", () => ({
	agentSessionForOwner: async (_userId: string, id: string) => ({
		id,
		taskPlacement: null,
	}),
}));
let db: PGlite;
const session = randomUUID(),
	project = randomUUID();
beforeEach(async () => {
	coordinate.mockReset().mockResolvedValue(true);
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
	// The caller decides how a different model reads it (provider-neutral).
	expect(await recoveredConversation("alice", session)).toEqual({
		messages: [],
		modelId: "model",
		revision: "revision",
	});
	expect(await recoveredConversation("bob", session)).toBeNull();
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

it("restores a builder-direct root chat's own checkout to its code point", async () => {
	const snapshot = (tree: string) => ({
		cwd: "/workspace/repo",
		tree: tree.repeat(40),
		indexTree: tree.repeat(40),
		head: "c".repeat(40),
		ref: `refs/ytimesy/recovery/${tree}`,
	});
	await db.query(
		"update agent_task_command_receipt set response=jsonb_set(response,'{result,code}',$2::jsonb) where parent_session_id=$1",
		[session, JSON.stringify(snapshot("a"))],
	);
	await db.query("update agent_session set provider_ref='vm-1' where id=$1", [
		session,
	]);
	code.capture.mockResolvedValue(snapshot("b"));
	code.restore.mockResolvedValue(undefined);
	const ensureRunning = vi.fn(async () => {});
	const recovered = await recoverConversation(
		{ ensureRunning } as unknown as WorkspaceMachines,
		"alice",
		{
			projectId: project,
			sessionId: session,
			messageId: "first",
			mode: "code",
		},
	);
	expect(recovered).toEqual({ id: session, prompt: null });
	expect(ensureRunning).toHaveBeenCalledWith("vm-1");
	expect(code.restore).toHaveBeenCalledWith(
		expect.objectContaining({ vm: "vm-1", cwd: "/workspace/repo" }),
		snapshot("a"),
		snapshot("b"),
	);
	// A root chat is not a reviewable task; code-only restore leaves review state alone.
	expect(
		(
			await db.query<{ task_review_state: unknown }>(
				"select task_review_state from agent_session where id=$1",
				[session],
			)
		).rows[0].task_review_state,
	).toBeNull();
});

it("holds the chat through a long code restore and frees it before committing", async () => {
	const snapshot = (tree: string) => ({
		cwd: "/workspace/repo",
		tree: tree.repeat(40),
		indexTree: tree.repeat(40),
		head: "c".repeat(40),
		ref: `refs/ytimesy/recovery/${tree}`,
	});
	await db.query(
		"update agent_task_command_receipt set response=jsonb_set(response,'{result,code}',$2::jsonb) where parent_session_id=$1",
		[session, JSON.stringify(snapshot("a"))],
	);
	await db.query("update agent_session set provider_ref='vm-1' where id=$1", [
		session,
	]);
	const steps: string[] = [];
	coordinate.mockImplementation(async (action) => {
		steps.push(action);
		return true;
	});
	const query = holder.query.getMockImplementation();
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		if (sql === "commit") steps.push("commit");
		return query?.(sql, values);
	});
	code.capture.mockResolvedValue(snapshot("b"));
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		code.restore.mockImplementation(async () => {
			// The restore outlives several coordination lease periods.
			vi.advanceTimersByTime(45_000);
		});
		await recoverConversation(
			{ ensureRunning: async () => {} } as unknown as WorkspaceMachines,
			"alice",
			{
				projectId: project,
				sessionId: session,
				messageId: "first",
				mode: "code",
			},
		);
	} finally {
		vi.useRealTimers();
	}
	expect(steps).toEqual([
		"acquire",
		"renew",
		"renew",
		"renew",
		"renew",
		"release",
		"commit",
	]);
});

it("rolls back a restore whose hold on the chat lapsed", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	coordinate.mockImplementation(async (action) => action !== "renew");
	try {
		const sessionRow = await db.query<{ items: unknown }>(
			"select items from agent_session where id=$1",
			[session],
		);
		holder.connect.mockResolvedValue({
			query: async (sql: string, values: unknown[]) => {
				if (sql.startsWith("select messages,model_id"))
					vi.advanceTimersByTime(10_000);
				return holder.query(sql, values);
			},
			release() {},
		});
		await expect(
			recoverConversation({} as WorkspaceMachines, "alice", {
				projectId: project,
				sessionId: session,
				messageId: "first",
				mode: "conversation",
			}),
		).rejects.toThrow(/Lost hold of this chat/);
		expect(
			(
				await db.query<{ items: unknown }>(
					"select items from agent_session where id=$1",
					[session],
				)
			).rows[0].items,
		).toEqual(sessionRow.rows[0].items);
		expect(coordinate).toHaveBeenLastCalledWith("release", expect.anything());
	} finally {
		vi.useRealTimers();
	}
});

it("only rewinds checkouts a session owns", () => {
	expect(ownsWritableCheckout({ provider_ref: "vm" })).toBe(true);
	expect(ownsWritableCheckout({ provider_ref: null })).toBe(false);
	expect(
		ownsWritableCheckout({
			provider_ref: "vm",
			parent_session_id: "p",
			agent_role: "writer",
		}),
	).toBe(true);
	for (const agent_role of ["researcher", "reviewer", "checker", null] as const)
		expect(
			ownsWritableCheckout({
				provider_ref: "vm",
				parent_session_id: "p",
				agent_role,
			}),
		).toBe(false);
});
