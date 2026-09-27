import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { providerProjectTemplateSnapshot } from "../src/server/services/provider-project-template";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));
vi.mock("../src/server/auth/agent-account", () => ({
	loadHarnessSnapshotId: async () => "sh-private-auth",
}));
vi.mock("../src/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "ghs_test_only_secret",
}));
vi.mock("../src/server/adapters/github/bot-identity", () => ({
	resolveGithubAppBot: async () => null,
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated");
	await db.exec("create table workspace(id uuid primary key)");
	await db.exec(
		"create table project(id uuid primary key,user_id text,name text,repository_id bigint,installation_id bigint,full_name text,branch text); create table project_repository(project_id uuid,repository_id bigint,installation_id bigint,full_name text,branch text,position integer)",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260923011000_workspace_provider_templates.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260923012000_provider_template_auth_fingerprint.sql",
			"utf8",
		),
	);
	await db.exec(
		`insert into workspace(id) values('00000000-0000-4000-8000-000000000001');
		 insert into project(id,user_id,repository_id,installation_id,full_name,branch)
		 values('00000000-0000-4000-8000-000000000002','user-1',1,2,'acme/app','main')`,
	);
});
afterAll(() => db.close());

it("never copies Codex login into an execution image", async () => {
	const provisionSession = vi.fn(
		async (_slug: string, _snapshotId: string) => "vm-template",
	);
	const snapshotEnvironment = vi.fn(async () => "sh-combined");
	const destroy = vi.fn(async () => undefined);
	const exec = vi.fn(async (_vm: unknown, command: string) => ({
		exitCode: 0,
		stdout: command.startsWith("printf")
			? "/home/ubuntu"
			: command.startsWith("ls -1")
				? "package-lock.json\n"
				: "",
		stderr: "",
	}));
	const machines = {
		provisionSession,
		snapshotEnvironment,
		destroy,
		exec,
		writeTextFile: vi.fn(async () => undefined),
		ensureRunning: vi.fn(async (vm) => vm),
	} as unknown as WorkspaceMachines;
	const input = {
		machines,
		userId: "user-1",
		projectId: "00000000-0000-4000-8000-000000000002",
		workspaceId: "00000000-0000-4000-8000-000000000001",
		projectSnapshotId: "sh-project",
		harness: "codex" as const,
	};
	expect(await providerProjectTemplateSnapshot(input)).toBe("sh-project");
	expect(provisionSession).not.toHaveBeenCalled();
	expect(snapshotEnvironment).not.toHaveBeenCalled();
	expect(destroy).not.toHaveBeenCalled();
});

it("preserves the separate Claude project template path", async () => {
	const provisionSession = vi.fn(async () => "vm-template-claude");
	const machines = {
		provisionSession,
		snapshotEnvironment: vi.fn(async () => "sh-claude-combined"),
		destroy: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: "/home/ubuntu",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
		ensureRunning: vi.fn(async (vm) => vm),
	} as unknown as WorkspaceMachines;
	const result = await providerProjectTemplateSnapshot({
		machines,
		userId: "user-1",
		projectId: "00000000-0000-4000-8000-000000000002",
		workspaceId: "00000000-0000-4000-8000-000000000001",
		projectSnapshotId: "sh-project",
		harness: "claude",
	});
	expect(result).toBe("sh-claude-combined");
	expect(provisionSession).toHaveBeenCalledWith(
		expect.any(String),
		"sh-private-auth",
	);
});
