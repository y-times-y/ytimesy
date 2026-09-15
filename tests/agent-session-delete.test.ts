import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { saveProject } from "../src/server/adapters/projects";
import { deleteAgentSessionMachine } from "../src/server/services/agent-session-machine";
import { emptyCodexSession } from "../src/server/services/codex-workspace-session";
import {
	persistBoundSessionView,
	persistSessionTurnStatus,
} from "../src/server/services/persist-session-view";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
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
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

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

it("drops an attach-legacy row without deleting the template VM", async () => {
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
