import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	disconnectAgentAccount,
	loadAgentAccount,
} from "../src/server/auth/agent-account";
import { codexExternalTokens } from "../src/server/auth/codex-managed-auth";
import { seal } from "../src/server/auth/token-vault";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
		connect: async () => ({
			query: (sql: string, params?: unknown[]) => db.query(sql, params),
			release: () => undefined,
		}),
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
		"20260923014000_codex_managed_auth.sql",
		"20260927210000_project_environments.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

async function storeLogin(userId: string, login: string) {
	await db.query(
		"insert into agent_account(user_id,provider,status,encrypted_codex_auth,plan_type) values($1,'codex','connected',$2,'prolite')",
		[userId, await seal(login)],
	);
}

it("reads a stored ChatGPT login and keeps accounts isolated by user", async () => {
	const payload = Buffer.from(
		JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
	).toString("base64url");
	const login = JSON.stringify({
		auth_mode: "chatgpt",
		tokens: {
			access_token: `header.${payload}.signature`,
			refresh_token: "refresh-test-only",
			account_id: "account-test-only",
		},
	});
	await storeLogin("alice", login);
	const stored = await db.query<{ encrypted_codex_auth: string }>(
		"select encrypted_codex_auth from agent_account where user_id='alice'",
	);
	expect(stored.rows[0].encrypted_codex_auth).not.toContain(
		"refresh-test-only",
	);
	expect(await loadAgentAccount("alice")).toMatchObject({
		status: "connected",
		provider: "codex",
		planType: "prolite",
	});
	expect(await codexExternalTokens("alice")).toEqual({
		accessToken: `header.${payload}.signature`,
		chatgptAccountId: "account-test-only",
	});
	expect(await loadAgentAccount("bob")).toEqual({ status: "disconnected" });
	await disconnectAgentAccount("alice");
	expect(await loadAgentAccount("alice")).toEqual({ status: "disconnected" });
});
