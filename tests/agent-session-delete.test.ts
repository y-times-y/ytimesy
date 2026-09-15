import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { saveProject } from "../src/server/adapters/projects";
import { deleteAgentSessionMachine } from "../src/server/services/agent-session-machine";

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
	const template = await db.query(
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
