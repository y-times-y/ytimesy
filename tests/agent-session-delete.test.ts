import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import {
	insertAgentSession,
	saveAgentTaskPublication,
	saveAgentTaskReview,
	saveAgentTaskState,
	saveSessionBranchSelection,
	saveSessionWorkingBranch,
	selectAgentSessionHarness,
} from "../src/server/adapters/agent-sessions";
import { saveProject } from "../src/server/adapters/projects";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
	openAgentSession,
	openAgentTask,
	prepareAgentTaskStart,
} from "../src/server/services/agent-session-machine";
import { emptyCodexSession } from "../src/server/services/codex-workspace-session";
import {
	persistBoundSessionView,
	persistSessionTurnStatus,
} from "../src/server/services/persist-session-view";
import * as turnCommit from "../src/server/services/turn-commit";

let db: PGlite;
const query = async (sql: string, params?: unknown[]) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query,
		connect: async () => ({ query, release() {} }),
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "[REDACTED]",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	await db.exec("create table api_turn(session_id uuid,state text)");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
		"20260913234500_auth_email_outbox.sql",
		"20260914010000_auth_email_reset_password.sql",
		"20260915053000_agent_sessions_and_snapshots.sql",
		"20260915060000_agent_session_parent.sql",
		"20260915083000_product_setting.sql",
		"20260915103000_agent_session_listed_model.sql",
		"20260915110000_agent_session_turn_status.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260923010000_agent_task_command_receipts.sql",
		"20260923013000_agent_task_command_heartbeat.sql",
		"20260919161500_workspace_snapshot_source.sql",
		"20260927210000_project_environments.sql",
		"20260927220000_agent_competitions.sql",
		"20260930220000_chat_branches.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

it("persists branch drafts independently across chats and protects ownership", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const a = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	const b = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	await db.query(
		"insert into agent_task_command_receipt(parent_session_id,request_id,status) values($1,'verification-baseline:/repo','processing'),($1,'completion-verification:turn:/repo','processing'),($1,'other-operation','processing'),($2,'verification-baseline:/repo','processing')",
		[a.id, b.id],
	);
	await saveSessionBranchSelection("alice", a.id, "feature");
	expect(
		(
			await db.query(
				"select request_id from agent_task_command_receipt where parent_session_id=$1",
				[a.id],
			)
		).rows,
	).toEqual([{ request_id: "other-operation" }]);
	expect(
		(
			await db.query(
				"select request_id from agent_task_command_receipt where parent_session_id=$1",
				[b.id],
			)
		).rows,
	).toHaveLength(1);
	const rows = await db.query<{
		id: string;
		selected_branch: string | null;
		working_branch: string | null;
	}>(
		"select id,selected_branch,working_branch from agent_session where id in ($1,$2)",
		[a.id, b.id],
	);
	expect(rows.rows.find((row) => row.id === a.id)?.selected_branch).toBe(
		"feature",
	);
	expect(rows.rows.find((row) => row.id === b.id)?.selected_branch).toBeNull();
	expect(rows.rows.every((row) => row.working_branch === null)).toBe(true);
	expect(
		(
			await db.query<{ branch: string }>(
				"select branch from project where id=$1",
				[project.id],
			)
		).rows[0].branch,
	).toBe("main");
	await expect(
		saveSessionBranchSelection("bob", a.id, "main"),
	).rejects.toThrow();
	await db.query("update agent_session set turn_status='running' where id=$1", [
		a.id,
	]);
	await expect(
		saveSessionWorkingBranch("alice", a.id, "main"),
	).rejects.toThrow();
});

async function readyWorkspace() {
	const project = await saveProject(
		"alice",
		{
			installationId: 1,
			repositoryId: Math.floor(Math.random() * 100000),
			fullName: `test/delete-${Date.now()}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id)
		 values($1,'alice',$2,'ready','vm-template','snap-1')`,
		[workspaceId, project.id],
	);
	return { project, workspaceId };
}

it("starts a new lead without write access to its own workspace", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	expect(session.taskAccess).toBe("read_only");
	expect(session.parentSessionId).toBeNull();
});

it("persists the selected runtime before a reused chat starts polling", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "claude",
		providerRef: "vm-agent",
		listedModelId: "claude-old",
	});
	const bound = await bindAgentSessionMachine(
		{ ensureRunning: async () => {} } as never,
		{
			userId: "alice",
			projectId: project.id,
			sessionId: session.id,
			harness: "codex",
		},
	);
	expect(bound.session.harness).toBe("codex");
	expect(
		(
			await db.query(
				"select harness,listed_model_id from agent_session where id=$1",
				[session.id],
			)
		).rows,
	).toEqual([{ harness: "codex", listed_model_id: null }]);
});

it("does not switch a running turn or another owner's runtime", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "claude",
		providerRef: "vm-agent",
	});
	await expect(
		selectAgentSessionHarness("bob", project.id, session.id, "codex"),
	).rejects.toThrow();
	await db.query("update agent_session set turn_status='running' where id=$1", [
		session.id,
	]);
	await expect(
		selectAgentSessionHarness("alice", project.id, session.id, "codex"),
	).rejects.toThrow();
	expect(
		(
			await db.query("select harness from agent_session where id=$1", [
				session.id,
			])
		).rows,
	).toEqual([{ harness: "claude" }]);
});

it("destroys agent copies and side-chat copies, never the template VM", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-agent",
	});
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-side",
		parentSessionId: parent.id,
	});
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
		},
		{ userId: "alice", projectId: project.id, sessionId: parent.id },
	);
	expect(destroyed.sort()).toEqual(["vm-agent", "vm-side"]);
	const remaining = await db.query(
		"select id from agent_session where project_id=$1",
		[project.id],
	);
	expect(remaining.rows).toEqual([]);
	const template = await db.query<{ provider_ref: string }>(
		"select provider_ref from workspace where id=$1",
		[workspaceId],
	);
	expect(template.rows[0]?.provider_ref).toBe("vm-template");
});

it("drops a leftover template-bound session row without deleting the template VM", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-template",
	});
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
		},
		{ userId: "alice", projectId: project.id, sessionId: session.id },
	);
	expect(destroyed).toEqual([]);
	const remaining = await db.query("select id from agent_session where id=$1", [
		session.id,
	]);
	expect(remaining.rows).toEqual([]);
});

it("deletes a shared child session without destroying its parent's machine", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-parent",
		listedModelId: "codex/gpt-test",
	});
	const child = await openAgentTask({
		userId: "alice",
		projectId: project.id,
		parentSessionId: parent.id,
		title: "Read-only audit",
		harness: "codex",
		modelId: "codex/gpt-test",
		prompt: "Inspect the current working tree without editing it.",
		placement: "shared",
		access: "read_only",
		execution: "parallel",
		dependsOnSessionId: null,
	});
	await db.query(
		"update agent_session set provider_ref='vm-parent' where id=$1",
		[child.id],
	);
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
		},
		{ userId: "alice", projectId: project.id, sessionId: child.id },
	);
	expect(destroyed).toEqual([]);
	expect(
		(await db.query("select id from agent_session where id=$1", [parent.id]))
			.rows,
	).toEqual([{ id: parent.id }]);
});

it("does not let another user delete a session", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-agent",
	});
	await expect(
		deleteAgentSessionMachine(
			{
				destroy: async () => {
					throw new Error("destroy must not run");
				},
			},
			{ userId: "bob", projectId: project.id, sessionId: session.id },
		),
	).rejects.toThrow("Agent session is not available.");
	const remaining = await db.query("select id from agent_session where id=$1", [
		session.id,
	]);
	expect(remaining.rows).toEqual([{ id: session.id }]);
});

it("stores the listed model last submitted on an agent session", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-agent",
		listedModelId: "opencode/big-pickle",
	});
	expect(session.listedModelId).toBe("opencode/big-pickle");
	const stored = await db.query<{ listed_model_id: string | null }>(
		"select listed_model_id from agent_session where id=$1",
		[session.id],
	);
	expect(stored.rows[0]?.listed_model_id).toBe("opencode/big-pickle");
});

it("keeps a running turn across a paused read until a live harness view arrives", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-agent",
	});
	expect(session.turnStatus).toBe("idle");
	await persistSessionTurnStatus(session, "running");
	const paused = await persistBoundSessionView(session, emptyCodexSession());
	expect(paused.turnStatus).toBe("running");
	const stored = await db.query<{ turn_status: string }>(
		"select turn_status from agent_session where id=$1",
		[session.id],
	);
	expect(stored.rows[0]?.turn_status).toBe("running");
	const completed = await persistBoundSessionView(session, {
		...emptyCodexSession(),
		connection: {
			status: "authenticated",
			provider: "opencode",
			authMode: "local",
			planType: null,
			email: null,
		},
		turnStatus: "completed",
		items: [
			{ kind: "userMessage", id: SessionItemId("u1"), text: "ping" },
			{ kind: "agentMessage", id: SessionItemId("a1"), text: "pong" },
		],
	});
	expect(completed.turnStatus).toBe("completed");
});

it("commits before exposing completion and preserves retryable state on a Git failure", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-writer",
	});
	await db.query(
		"update agent_session set task_access='read_write',turn_status='running' where id=$1",
		[session.id],
	);
	const view = {
		...emptyCodexSession(),
		connection: {
			status: "authenticated" as const,
			provider: "opencode" as const,
			authMode: "local" as const,
			planType: null,
			email: null,
		},
		turnStatus: "completed" as const,
		items: [
			{ kind: "userMessage" as const, id: SessionItemId("u1"), text: "ping" },
			{ kind: "agentMessage" as const, id: SessionItemId("a1"), text: "pong" },
		],
	};
	const commit = vi.spyOn(turnCommit, "commitCompletedSessionTurn");
	try {
		commit.mockRejectedValueOnce(new Error("Git hook failed"));
		await expect(persistBoundSessionView(session, view)).rejects.toThrow(
			"Git hook failed",
		);
		expect(
			(
				await db.query<{ turn_status: string }>(
					"select turn_status from agent_session where id=$1",
					[session.id],
				)
			).rows[0].turn_status,
		).toBe("running");
		commit.mockImplementationOnce(async () => {
			expect(
				(
					await db.query<{ turn_status: string }>(
						"select turn_status from agent_session where id=$1",
						[session.id],
					)
				).rows[0].turn_status,
			).toBe("running");
		});
		expect((await persistBoundSessionView(session, view)).turnStatus).toBe(
			"completed",
		);
		await persistBoundSessionView(session, view);
		expect(commit).toHaveBeenCalledTimes(2);
		await db.query(
			"update agent_session set turn_status='running' where id=$1",
			[session.id],
		);
		const followup = [
			{ kind: "userMessage", id: SessionItemId("u2"), text: "Next task" },
		];
		commit.mockImplementationOnce(async () => {
			await db.query("update agent_session set items=$2::jsonb where id=$1", [
				session.id,
				JSON.stringify(followup),
			]);
		});
		const raced = await persistBoundSessionView(session, view);
		expect(raced.turnStatus).toBe("running");
		expect(raced.canSend).toBe(false);
		expect(raced.items).toEqual(followup);
	} finally {
		commit.mockRestore();
	}
});

it("opens a new chat without copying a VM and inherits the last listed model", async () => {
	const { project, workspaceId } = await readyWorkspace();
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "opencode",
		providerRef: "vm-sibling",
		listedModelId: "opencode/big-pickle",
	});
	const opened = await openAgentSession({
		userId: "alice",
		projectId: project.id,
		harness: "opencode",
	});
	expect(opened.providerRef).toBeNull();
	expect(opened.title).toBe("New session");
	expect(opened.listedModelId).toBe("opencode/big-pickle");
	expect(opened.turnStatus).toBe("idle");
	const stored = await db.query<{
		provider_ref: string | null;
		listed_model_id: string | null;
	}>("select provider_ref, listed_model_id from agent_session where id=$1", [
		opened.id,
	]);
	expect(stored.rows[0]?.provider_ref).toBeNull();
	expect(stored.rows[0]?.listed_model_id).toBe("opencode/big-pickle");
});

it("stores drafts without compute and gates stacked work on reviewed predecessors", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const root = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		listedModelId: "codex/gpt-test",
	});
	const first = await openAgentTask({
		userId: "alice",
		projectId: project.id,
		parentSessionId: root.id,
		title: "Schema",
		harness: "codex",
		modelId: "codex/gpt-test",
		prompt: "Implement and verify the schema.",
		placement: "fresh",
		access: "read_write",
		execution: "parallel",
		dependsOnSessionId: null,
	});
	expect(first.taskState).toBe("draft");
	expect(first.providerRef).toBeNull();
	const second = await openAgentTask({
		userId: "alice",
		projectId: project.id,
		parentSessionId: root.id,
		title: "API",
		harness: "codex",
		modelId: "codex/gpt-test",
		prompt: "Build the API on the reviewed schema.",
		placement: "fresh",
		access: "read_write",
		execution: "stacked",
		dependsOnSessionId: first.id,
	});
	await expect(
		prepareAgentTaskStart({
			userId: "alice",
			projectId: project.id,
			taskSessionId: second.id,
		}),
	).rejects.toThrow("finish");
	await saveAgentTaskState(first.id, "done");
	await expect(
		prepareAgentTaskStart({
			userId: "alice",
			projectId: project.id,
			taskSessionId: second.id,
		}),
	).rejects.toThrow("Review");
	await saveAgentTaskReview(first.id, "reviewed");
	await expect(
		prepareAgentTaskStart({
			userId: "alice",
			projectId: project.id,
			taskSessionId: second.id,
		}),
	).rejects.toThrow("Publish");
	await saveAgentTaskPublication(first.id, {
		branch: "ytimesy-task-1",
		pullRequestUrl: "https://example.test/pull/1",
	});
	const started = await prepareAgentTaskStart({
		userId: "alice",
		projectId: project.id,
		taskSessionId: second.id,
	});
	expect(started.task.taskState).toBe("working");
});
