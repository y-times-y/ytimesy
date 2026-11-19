import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { persistAuthEmail } from "../src/server/adapters/email";
import { unseal } from "../src/server/auth/token-vault";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));
vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
		"20260913234500_auth_email_outbox.sql",
		"20260914010000_auth_email_reset_password.sql",
		"20261119120000_auth_email_account_exists.sql",
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

it("encrypts verification URLs and keeps them off Data API roles", async () => {
	const actionUrl =
		"http://verify.example.test/api/auth/verify-email?token=secret-verify-token&callbackURL=/";
	await persistAuthEmail({
		to: "het@example.test",
		subject: "Verify your ytimesy email",
		purpose: "verify-email",
		actionUrl,
	});
	const stored = await db.query<{ encrypted_action_url: string }>(
		"select encrypted_action_url from auth_email_outbox",
	);
	expect(stored.rows[0].encrypted_action_url).not.toContain(
		"secret-verify-token",
	);
	expect(await unseal(stored.rows[0].encrypted_action_url)).toBe(actionUrl);
	for (const role of ["anon", "authenticated"]) {
		const grants = await db.query<{ allowed: boolean }>(
			"select has_table_privilege($1,'auth_email_outbox','SELECT') as allowed",
			[role],
		);
		expect(grants.rows[0].allowed).toBe(false);
	}
});

it("encrypts password-reset URLs under the reset-password purpose", async () => {
	const actionUrl =
		"http://verify.example.test/api/auth/reset-password/secret-reset-token?callbackURL=/auth/reset-password";
	await persistAuthEmail({
		to: "het@example.test",
		subject: "Reset your ytimesy password",
		purpose: "reset-password",
		actionUrl,
	});
	const stored = await db.query<{
		purpose: string;
		encrypted_action_url: string;
	}>(
		"select purpose, encrypted_action_url from auth_email_outbox where purpose='reset-password'",
	);
	expect(stored.rows).toHaveLength(1);
	expect(stored.rows[0].encrypted_action_url).not.toContain(
		"secret-reset-token",
	);
	expect(await unseal(stored.rows[0].encrypted_action_url)).toBe(actionUrl);
});

it("queues an account-exists message once per address in the window, however often it is asked", async () => {
	const send = (to: string, within?: number) =>
		persistAuthEmail({
			to,
			subject: "You already have a ytimesy account",
			purpose: "account-exists",
			actionUrl: "https://app.example.test/auth/sign-in",
			...(within === undefined ? {} : { skipIfQueuedWithinMs: within }),
		});
	await send("owner@example.test", 600_000);
	await send("owner@example.test", 600_000);
	await send("owner@example.test", 600_000);
	await send("other@example.test", 600_000);
	const count = async (to: string) =>
		(
			await db.query<{ n: number }>(
				"select count(*)::int as n from auth_email_outbox where purpose='account-exists' and to_address=$1",
				[to],
			)
		).rows[0].n;
	expect(await count("owner@example.test")).toBe(1);
	// Another address is not held back by it.
	expect(await count("other@example.test")).toBe(1);
	// Once the window has passed, the owner can be told again.
	await db.query(
		"update auth_email_outbox set created_at = now() - interval '11 minutes' where purpose='account-exists' and to_address='owner@example.test'",
	);
	await send("owner@example.test", 600_000);
	expect(await count("owner@example.test")).toBe(2);
	// Without the option every call queues, as verification and reset do.
	await send("plain@example.test");
	await send("plain@example.test");
	expect(await count("plain@example.test")).toBe(2);
});

it("rejects outbox purposes other than verify-email, reset-password and account-exists", async () => {
	await expect(
		db.exec(
			"insert into auth_email_outbox(to_address, subject, purpose, encrypted_action_url) values('het@example.test','x','welcome','sealed')",
		),
	).rejects.toThrow();
});
