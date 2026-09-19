import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { saveProject } from "../src/server/adapters/projects";
import { MemoryWorkspaceRuntime } from "../src/server/adapters/workspace-runtime";
import {
	insertQueuedWorkspace,
	listWorkspaceEvents,
	saveProviderRef,
	saveWorkspaceStatus,
	workspaceById,
} from "../src/server/adapters/workspaces";
import {
	disconnectAgentAccount,
	saveConnectedAgentAccount,
} from "../src/server/auth/agent-account";
import { runWorkspacePreparation } from "../src/server/jobs/prepare-workspace";

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
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: async () => "ghp_secretfixturetoken",
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: async (
		_token: string,
		installationId: number,
		repositoryId: number,
	) => ({
		installationId,
		repositoryId,
		fullName: "acme/app",
		defaultBranch: "main",
	}),
}));
vi.mock("../src/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "ghs_secretfixturetoken",
}));

const toolsSnapshot = { id: undefined as string | undefined };
vi.mock("../src/server/records/tools-snapshot-store", () => ({
	readToolsSnapshotId: async () => toolsSnapshot.id,
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
		"20260919161500_workspace_snapshot_source.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true)`,
	);
});
afterAll(() => db.close());

const repo = {
	installationId: 1,
	repositoryId: 9,
	fullName: "acme/app",
	defaultBranch: "main",
};

it("clones with an installation token file, not git argv", async () => {
	vi.stubEnv("GITHUB_APP_BOT_USER_ID", "328807657");
	vi.stubEnv("GITHUB_APP_SLUG", "ytimesy-cloud");
	const project = await saveProject("alice", repo, "main");
	const workspace = await insertQueuedWorkspace("alice", project.id);
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "pnpm-lock.yaml\n",
		stderr: "",
	});
	await runtime.provision(`ytimesy-ws-${workspace.id}`);
	const ready = await runWorkspacePreparation(workspace.id, runtime);
	expect(ready?.status).toBe("ready");
	expect(ready?.templateSnapshotId).toMatch(/^snap:ytimesy-pe-/);
	expect(runtime.paused).toHaveLength(1);
	expect(runtime.machines.size).toBe(1);
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("git clone"),
		),
	).toBe(true);
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("ghs_secretfixturetoken"),
		),
	).toBe(false);
	expect(
		runtime.files.some((file) => file.path === "/tmp/ytimesy-gh-token"),
	).toBe(true);
	expect(
		runtime.files.some((file) => file.path.endsWith("/.git/hooks/commit-msg")),
	).toBe(true);
	vi.unstubAllEnvs();
	const events = await listWorkspaceEvents("alice", workspace.id);
	expect(events.map((event) => event.message)).toContain(
		"Sealed project environment snapshot.",
	);
	expect(events.map((event) => event.message).join("\n")).not.toContain("ghp_");
});

it("boots a new machine from the user's Codex snapshot when one exists", async () => {
	await saveConnectedAgentAccount("alice", {
		provider: "codex",
		snapshotId: "sh-alice-codex",
		planType: "prolite",
		email: "alice@example.test",
	});
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 11,
			fullName: "acme/snapshot",
		},
		"main",
	);
	const workspace = await insertQueuedWorkspace("alice", project.id);
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "pnpm-lock.yaml\n",
		stderr: "",
	});
	await runWorkspacePreparation(workspace.id, runtime);
	expect(runtime.lastProvisionOptions).toEqual({
		snapshotId: "sh-alice-codex",
	});
	await disconnectAgentAccount("alice");
});

it("boots from the shared tools snapshot when the user has no auth snapshot", async () => {
	vi.stubEnv("YTIMESY_TOOLS_SNAPSHOT_ID", "sh-tools");
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 12,
			fullName: "acme/tools-image",
		},
		"main",
	);
	const workspace = await insertQueuedWorkspace("alice", project.id);
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "pnpm-lock.yaml\n",
		stderr: "",
	});
	await runWorkspacePreparation(workspace.id, runtime);
	expect(runtime.lastProvisionOptions).toEqual({
		snapshotId: "sh-tools",
	});
	vi.unstubAllEnvs();
});

it("boots from the local tools snapshot file when env is unset", async () => {
	toolsSnapshot.id = "sh-from-file";
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 13,
			fullName: "acme/tools-file",
		},
		"main",
	);
	const workspace = await insertQueuedWorkspace("alice", project.id);
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "pnpm-lock.yaml\n",
		stderr: "",
	});
	await runWorkspacePreparation(workspace.id, runtime);
	expect(runtime.lastProvisionOptions).toEqual({
		snapshotId: "sh-from-file",
	});
	toolsSnapshot.id = undefined;
});

it("recovers a recorded provider instead of creating a second machine", async () => {
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 10,
			fullName: "acme/recover",
		},
		"main",
	);
	const workspace = await insertQueuedWorkspace("alice", project.id);
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "package-lock.json\n",
		stderr: "",
	});
	const providerRef = await runtime.provision(`ytimesy-ws-${workspace.id}`);
	await saveProviderRef(workspace.id, providerRef);
	await saveWorkspaceStatus(workspace.id, "provisioning");
	const originalCreate = runtime.provision.bind(runtime);
	let provisions = 0;
	runtime.provision = async (slug) => {
		provisions += 1;
		return originalCreate(slug);
	};
	await runWorkspacePreparation(workspace.id, runtime);
	expect(provisions).toBe(0);
	expect((await workspaceById(workspace.id))?.status).toBe("ready");
});
