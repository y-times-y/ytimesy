import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WorkspaceId } from "../src/domain/ids";
import { persistCodexAuthSnapshotForUser } from "../src/server/proof/persist-codex-auth-snapshot";
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
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
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
		"20260920010000_agent_account_per_provider.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260927210000_project_environments.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true)`,
	);
});
afterAll(() => db.close());

it("does not recapture a snapshot the user already has stored", async () => {
	const { saveConnectedAgentAccount } = await import(
		"../src/server/auth/agent-account"
	);
	await saveConnectedAgentAccount("alice", {
		provider: "codex",
		snapshotId: "sh-existing",
		planType: "prolite",
		email: "alice@example.test",
	});
	const machines = {
		snapshotAuthenticatedWorkspace: async () => {
			throw new Error("should not snapshot again");
		},
	} as unknown as WorkspaceMachines;
	const result = await Effect.runPromise(
		persistCodexAuthSnapshotForUser(
			"alice",
			machines,
			WorkspaceId("vm-prepared"),
			{ planType: "prolite", email: "alice@example.test" },
		),
	);
	expect(result).toMatchObject({
		kind: "existing",
		snapshot: { snapshotId: "sh-existing" },
	});
});
