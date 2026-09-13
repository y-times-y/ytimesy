import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { saveProject } from "../src/server/adapters/projects";
import {
	listWorkspaceEvents,
	workspaceForProject,
} from "../src/server/adapters/workspaces";
import { enqueueProjectWorkspace } from "../src/server/services/workspaces";

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
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

const repo = {
	installationId: 1,
	repositoryId: 2,
	fullName: "test/repo",
	defaultBranch: "main",
};

it("keeps workspace rows owner-scoped and reuses one workspace per project", async () => {
	const project = await saveProject("alice", repo, "main");
	const jobs: string[] = [];
	const queue = {
		enqueuePrepare: async (workspaceId: string) => {
			jobs.push(workspaceId);
			return "job-1";
		},
	};
	const first = await Effect.runPromise(
		enqueueProjectWorkspace("alice", project.id, queue),
	);
	const second = await Effect.runPromise(
		enqueueProjectWorkspace("alice", project.id, queue),
	);
	expect(first.id).toBe(second.id);
	expect(first.status).toBe("queued");
	expect(await workspaceForProject("bob", project.id)).toBeNull();
	await expect(
		Effect.runPromise(enqueueProjectWorkspace("bob", project.id, queue)),
	).rejects.toThrow();
	expect(jobs).toEqual([first.id, first.id]);
});

it("does not enqueue a second machine after preparation has started", async () => {
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 3,
			fullName: "test/other",
		},
		"main",
	);
	const queue = { enqueuePrepare: async () => "job-2" };
	const queued = await Effect.runPromise(
		enqueueProjectWorkspace("alice", project.id, queue),
	);
	await db.query("update workspace set status='provisioning' where id=$1", [
		queued.id,
	]);
	const again = await Effect.runPromise(
		enqueueProjectWorkspace("alice", project.id, queue),
	);
	expect(again.status).toBe("provisioning");
	expect(again.id).toBe(queued.id);
});

it("records queue failures without storing secrets", async () => {
	const project = await saveProject(
		"alice",
		{
			...repo,
			repositoryId: 4,
			fullName: "test/logs",
		},
		"main",
	);
	const queued = await Effect.runPromise(
		enqueueProjectWorkspace("alice", project.id, {
			enqueuePrepare: async () => {
				throw new Error("AUTHORIZATION: bearer ghp_secretvalue");
			},
		}),
	);
	const events = await listWorkspaceEvents("alice", queued.id);
	expect(events[0].message).not.toContain("ghp_");
	expect(events[0].message).toContain("Job queue is unavailable");
});
