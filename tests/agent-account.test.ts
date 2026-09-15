import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	disconnectAgentAccount,
	loadAgentAccount,
	loadAgentSnapshotId,
	saveConnectedAgentAccount,
} from "../src/server/auth/agent-account";

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
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

it("encrypts snapshot ids and keeps accounts isolated by user", async () => {
	await saveConnectedAgentAccount("alice", {
		provider: "codex",
		snapshotId: "snap-secret",
		planType: "prolite",
		email: "alice@example.test",
	});
	const stored = await db.query<{ encrypted_snapshot_id: string }>(
		"select encrypted_snapshot_id from agent_account where user_id='alice'",
	);
	expect(stored.rows[0].encrypted_snapshot_id).not.toContain("snap-secret");
	expect(await loadAgentAccount("alice")).toEqual({
		status: "connected",
		provider: "codex",
		planType: "prolite",
		email: "alice@example.test",
	});
	expect(await loadAgentSnapshotId("alice")).toBe("snap-secret");
	expect(await loadAgentAccount("bob")).toEqual({ status: "disconnected" });
	expect(await loadAgentSnapshotId("bob")).toBeNull();
	await disconnectAgentAccount("alice");
	expect(await loadAgentAccount("alice")).toEqual({ status: "disconnected" });
	expect(await loadAgentSnapshotId("alice")).toBeNull();
});
