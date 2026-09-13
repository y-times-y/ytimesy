import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { persistVerificationEmail } from "../src/server/adapters/email";
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
		"20260913234500_auth_email_outbox.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

it("encrypts verification URLs and keeps them off Data API roles", async () => {
	const actionUrl =
		"http://verify.example.test/api/auth/verify-email?token=secret-verify-token&callbackURL=/";
	await persistVerificationEmail({
		to: "het@example.test",
		subject: "Verify your ytimesy email",
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
