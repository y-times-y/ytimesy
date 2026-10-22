import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { SessionItemId } from "#/domain/ids";
import {
	forkCodeStart,
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
	present: vi.fn(),
	start: vi.fn(),
}));
vi.mock("../services/conversation-code-checkpoint", () => ({
	captureConversationCode: code.capture,
	restoreConversationCode: code.restore,
	assertConversationCodePresent: code.present,
	startCheckoutFromConversationCode: code.start,
}));
vi.mock("./project-machine-size", () => ({
	projectMachineSize: async () => undefined,
}));
const coordinate = vi.hoisted(() => vi.fn(async (_action: string) => true));
vi.mock("./conversation-turn-control", () => ({
	coordinateConversationTurn: coordinate,
}));
vi.mock("./agent-sessions", () => ({
	agentSessionForOwner: async (userId: string, id: string) => {
		const row = (
			await holder.query(
				"select * from agent_session where id=$1 and user_id=$2",
				[id, userId],
			)
		).rows[0];
		return row
			? {
					id,
					userId,
					projectId: row.project_id,
					title: row.title,
					turnStatus: row.turn_status,
					providerRef: row.provider_ref,
					parentSessionId: row.parent_session_id,
					agentRole: row.agent_role,
					baseBranch: row.base_branch,
					taskPlacement: null,
				}
			: null;
	},
	projectBranchHeldByOtherSession: async () => false,
}));
let db: PGlite;
const session = randomUUID(),
	project = randomUUID();
beforeEach(async () => {
	coordinate.mockReset().mockResolvedValue(true);
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,title text,listed_model_id text,status text,turn_status text,task_access text,selected_branch text,working_branch text,base_branch text,task_branch text,agent_role text,parent_session_id uuid,provider_ref text,task_placement text,items jsonb default '[]',task_summary text,task_review_state text,updated_at timestamptz default now());
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

describe("forking at a message", () => {
	const snapshot = (tree: string) => ({
		cwd: "/workspace/repo",
		tree: tree.repeat(40),
		indexTree: tree.repeat(40),
		head: "c".repeat(40),
		ref: `refs/ytimesy/recovery/${tree}`,
	});
	const forkInput = {
		projectId: project,
		sessionId: session,
		messageId: "first",
		mode: "fork" as const,
	};
	const rows = async () =>
		(
			await db.query<Record<string, unknown>>(
				"select * from agent_session where user_id='alice' order by id=$1 desc",
				[session],
			)
		).rows;
	const machines = () => {
		const calls = {
			ensureRunning: vi.fn(async (vm: string) => vm),
			readTextFile: vi.fn(async () => "/workspace/repo\n"),
			forkWorkspace: vi.fn(async () => ({ vm: "vm-fork", forkMs: 5 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
			destroy: vi.fn(async () => {}),
		};
		return { calls, machines: calls as unknown as WorkspaceMachines };
	};
	beforeEach(async () => {
		code.present.mockReset().mockResolvedValue(undefined);
		code.start.mockReset().mockResolvedValue(undefined);
		code.restore.mockReset();
		await db.query(
			"update agent_task_command_receipt set response=jsonb_set(response,'{result,code}',$2::jsonb) where parent_session_id=$1",
			[session, JSON.stringify(snapshot("a"))],
		);
		await db.query(
			"update agent_session set provider_ref='vm-1',selected_branch='ytimesy/original-111111',working_branch='ytimesy/original-111111',base_branch='main' where id=$1",
			[session],
		);
	});

	it("copies the source VM and starts the copy at the message's code on the fork's own branch", async () => {
		const { calls, machines: vms } = machines();
		const recovered = await recoverConversation(vms, "alice", forkInput);
		expect(recovered.prompt).toBe("Implement");
		expect(calls.ensureRunning).toHaveBeenCalledWith("vm-1");
		expect(code.present).toHaveBeenCalledWith(
			expect.objectContaining({ vm: "vm-1", cwd: "/workspace/repo" }),
			snapshot("a"),
		);
		expect(calls.forkWorkspace).toHaveBeenCalledWith(
			"vm-1",
			agentSessionMachineSlug(recovered.id),
			undefined,
		);
		const [source, fork] = await rows();
		const branch = fork.working_branch as string;
		expect(branch).toMatch(/^ytimesy\/original-[a-f0-9]{6}$/);
		expect(branch).not.toBe(source.working_branch);
		expect(code.start).toHaveBeenCalledWith(
			expect.objectContaining({ vm: "vm-fork", cwd: "/workspace/repo" }),
			snapshot("a"),
			branch,
		);
		expect(fork).toMatchObject({
			id: recovered.id,
			provider_ref: "vm-fork",
			status: "ready",
			selected_branch: branch,
			base_branch: "main",
			parent_session_id: null,
			items: [],
		});
		// The source keeps its VM, branch, transcript and code.
		expect(source).toMatchObject({
			provider_ref: "vm-1",
			working_branch: "ytimesy/original-111111",
		});
		expect(source.items).toHaveLength(2);
		expect(code.restore).not.toHaveBeenCalled();
		expect(calls.destroy).not.toHaveBeenCalled();
	});

	it("fails without copying a VM when the source no longer holds the checkpoint", async () => {
		const { calls, machines: vms } = machines();
		code.present.mockRejectedValue(
			new Error(
				"This message's code checkpoint is gone, so the chat was not forked.",
			),
		);
		await expect(recoverConversation(vms, "alice", forkInput)).rejects.toThrow(
			"checkpoint is gone",
		);
		expect(calls.forkWorkspace).not.toHaveBeenCalled();
		expect(await rows()).toHaveLength(1);
	});

	it("removes the copied VM when the copy cannot start at the checkpoint or the fork is refused", async () => {
		const first = machines();
		code.start.mockRejectedValueOnce(new Error("checkout failed"));
		await expect(
			recoverConversation(first.machines, "alice", forkInput),
		).rejects.toThrow("checkout failed");
		expect(first.calls.destroy).toHaveBeenCalledWith("vm-fork");
		// A child task started while the VM was copied: the locked check refuses it.
		const second = machines();
		await db.query(
			"insert into agent_session(id,user_id,parent_session_id,turn_status)values($1,'alice',$2,'running')",
			[randomUUID(), session],
		);
		await expect(
			recoverConversation(second.machines, "alice", forkInput),
		).rejects.toThrow("child tasks");
		expect(second.calls.destroy).toHaveBeenCalledWith("vm-fork");
		expect(
			(await rows()).filter((row) => row.provider_ref === "vm-fork"),
		).toEqual([]);
	});

	it("refuses a message without a code checkpoint in a chat that has its own checkout", async () => {
		const { calls, machines: vms } = machines();
		await db.query(
			"update agent_task_command_receipt set response=response #- '{result,code}' where parent_session_id=$1",
			[session],
		);
		await expect(recoverConversation(vms, "alice", forkInput)).rejects.toThrow(
			"no code checkpoint",
		);
		expect(calls.forkWorkspace).not.toHaveBeenCalled();
		expect(forkCodeStart({ ownsCheckout: false, hasCheckpoint: false })).toBe(
			"fresh",
		);
		expect(forkCodeStart({ ownsCheckout: true, hasCheckpoint: true })).toBe(
			"checkpoint",
		);
	});

	it("gives a fork of a chat without a VM its own branch off the source's base, made at its first turn", async () => {
		await db.query("update agent_session set provider_ref=null where id=$1", [
			session,
		]);
		const { calls, machines: vms } = machines();
		const recovered = await recoverConversation(vms, "alice", forkInput);
		expect(calls.forkWorkspace).not.toHaveBeenCalled();
		const fork = (await rows())[1];
		expect(fork).toMatchObject({
			id: recovered.id,
			provider_ref: null,
			status: "starting",
			base_branch: "main",
		});
		expect(fork.working_branch).toMatch(/^ytimesy\/original-/);
		expect(fork.selected_branch).toBe(fork.working_branch);
	});
});
