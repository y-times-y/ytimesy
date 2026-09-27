import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	loadToolsSnapshotSetting,
	saveToolsSnapshotSetting,
} from "../src/server/adapters/product-settings";

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
		"20260920010000_agent_account_per_provider.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260927210000_project_environments.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

it("stores the tools snapshot so first boot does not depend on a gitignored file", async () => {
	expect(await loadToolsSnapshotSetting()).toBeUndefined();
	await saveToolsSnapshotSetting("sh-tools-base");
	expect(await loadToolsSnapshotSetting()).toBe("sh-tools-base");
	await saveToolsSnapshotSetting("sh-tools-refreshed");
	expect(await loadToolsSnapshotSetting()).toBe("sh-tools-refreshed");
});

it("rejects values that are not Freestyle snapshot ids", async () => {
	await expect(saveToolsSnapshotSetting("vm-not-a-snapshot")).rejects.toThrow(
		/private tools snapshot/,
	);
});
