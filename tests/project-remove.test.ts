import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { listProjects, saveProject } from "../src/server/adapters/projects";
import { removeProjectMachine } from "../src/server/services/projects";

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
		"20260930220000_chat_branches.sql",
		"20260920010000_agent_account_per_provider.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260919161500_workspace_snapshot_source.sql",
		"20260927210000_project_environments.sql",
		"20260927220000_agent_competitions.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

async function readyProject(userId: string, repositoryId: number) {
	const project = await saveProject(
		userId,
		{
			installationId: 1,
			repositoryId,
			fullName: `test/remove-${repositoryId}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id)
		 values($1,$2,$3,'ready','vm-template','snap-1')`,
		[workspaceId, userId, project.id],
	);
	return { project, workspaceId };
}

it("destroys session and template VMs, then drops the project row", async () => {
	const { project, workspaceId } = await readyProject("alice", 21);
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-agent",
	});
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-side",
		parentSessionId: parent.id,
	});
	const destroyed: string[] = [];
	await removeProjectMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
		},
		{ userId: "alice", projectId: project.id },
	);
	expect(destroyed.sort()).toEqual(["vm-agent", "vm-side", "vm-template"]);
	expect(await listProjects("alice")).toEqual([]);
	const sessions = await db.query(
		"select id from agent_session where project_id=$1",
		[project.id],
	);
	expect(sessions.rows).toEqual([]);
	const workspace = await db.query("select id from workspace where id=$1", [
		workspaceId,
	]);
	expect(workspace.rows).toEqual([]);
});

it("does not let another user remove a project", async () => {
	const { project } = await readyProject("alice", 22);
	await expect(
		removeProjectMachine(
			{
				destroy: async () => {
					throw new Error("destroy must not run");
				},
			},
			{ userId: "bob", projectId: project.id },
		),
	).rejects.toThrow("Project is not available.");
	expect(await listProjects("alice")).toEqual([
		expect.objectContaining({ id: project.id }),
	]);
});

it("still removes the project when Freestyle destroy fails", async () => {
	const { project } = await readyProject("alice", 23);
	await removeProjectMachine(
		{
			destroy: async () => {
				throw new Error("LIMIT_EXCEEDED");
			},
		},
		{ userId: "alice", projectId: project.id },
	);
	expect(
		(await listProjects("alice")).find((row) => row.id === project.id),
	).toBeUndefined();
});
