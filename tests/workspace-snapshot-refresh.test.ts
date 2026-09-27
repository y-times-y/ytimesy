import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { saveProject } from "../src/server/adapters/projects";
import { refreshWorkspaceSnapshot } from "../src/server/jobs/refresh-workspace";

let db: PGlite;
const github = vi.hoisted(() => ({
	token: vi.fn(),
	authorize: vi.fn(),
	sha: vi.fn(),
}));

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
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: github.token,
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: github.authorize,
	repositoryBranchSha: github.sha,
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
		"20260920010000_agent_account_per_provider.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260919161500_workspace_snapshot_source.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true)`,
	);
});
afterAll(() => db.close());

async function readyWorkspace(sourceSha: string | null) {
	const project = await saveProject(
		"alice",
		{
			installationId: 1,
			repositoryId: Math.floor(Math.random() * 100000),
			fullName: `test/refresh-${Date.now()}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id,template_source_ref,template_source_sha)
		 values($1,'alice',$2,'ready','vm-template','snap-old','main',$3)`,
		[workspaceId, project.id, sourceSha],
	);
	return { project, workspaceId };
}

it("does not boot a machine when the clone-source commit is unchanged", async () => {
	github.token.mockResolvedValue("token");
	github.authorize.mockResolvedValue({ defaultBranch: "main" });
	github.sha.mockResolvedValue("abc123");
	const { workspaceId } = await readyWorkspace("abc123");
	const runtime = {
		recover: vi.fn(async () => {
			throw new Error("must not recover");
		}),
		findBySlug: vi.fn(async () => null),
		provision: vi.fn(async () => {
			throw new Error("must not provision");
		}),
		exec: vi.fn(),
		writeTextFile: vi.fn(),
		snapshot: vi.fn(),
		pause: vi.fn(),
	};
	const workspace = await refreshWorkspaceSnapshot(workspaceId, runtime);
	expect(workspace?.status).toBe("ready");
	expect(workspace?.templateSnapshotId).toBe("snap-old");
	expect(runtime.recover).not.toHaveBeenCalled();
});

it("keeps the last good snapshot when a refresh fails", async () => {
	github.token.mockResolvedValue("token");
	github.authorize.mockResolvedValue({ defaultBranch: "main" });
	github.sha.mockResolvedValue("newsha");
	const { workspaceId } = await readyWorkspace("oldsha");
	const workspace = await refreshWorkspaceSnapshot(workspaceId, {
		recover: async () => {
			throw new Error("template is paused");
		},
		findBySlug: async () => null,
		provision: async () => {
			throw new Error("template is paused");
		},
		exec: async () => ({ exitCode: 1, stdout: "", stderr: "no" }),
		writeTextFile: async () => undefined,
		snapshot: async () => "snap-new",
	});
	expect(workspace?.status).toBe("ready");
	expect(workspace?.templateSnapshotId).toBe("snap-old");
});
