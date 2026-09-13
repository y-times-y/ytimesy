import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	finishGithubConnection,
	startGithubConnection,
} from "../src/server/auth/github-connection";

let db: PGlite;
const github = vi.hoisted(() => ({ exchange: vi.fn(), profile: vi.fn() }));
vi.mock("../src/server/adapters/github", () => ({
	exchangeGithubToken: github.exchange,
	githubClient: () => ({ users: { getAuthenticated: github.profile } }),
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "http://127.0.0.1:3001",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
		GITHUB_APP_CLIENT_ID: "test-client",
	}),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	await db.exec(
		await readFile(
			"supabase/migrations/20260913193000_identity_and_projects.sql",
			"utf8",
		),
	);
	await db.exec(`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
 insert into auth_account(id,"accountId","providerId","userId","updatedAt") values('a','123','github','alice',now());`);
	github.exchange.mockResolvedValue({
		accessToken: "secret-fixture-token",
		expiresAt: null,
	});
	github.profile.mockResolvedValue({ data: { id: 123 } });
});
afterAll(() => db.close());
it("binds single-use PKCE state to the signed-in user and encrypts stored credentials", async () => {
	const url = new URL(await startGithubConnection("alice"));
	const state = url.searchParams.get("state") ?? "";
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	await expect(finishGithubConnection("bob", state, "code")).rejects.toThrow();
	expect(github.exchange).not.toHaveBeenCalled();
	await finishGithubConnection("alice", state, "code");
	expect(github.exchange).toHaveBeenCalledOnce();
	expect(github.exchange.mock.calls[0][0].code_verifier).toHaveLength(43);
	const stored = await db.query<{ encrypted_credentials: string }>(
		"select encrypted_credentials from github_connection",
	);
	expect(stored.rows[0].encrypted_credentials).not.toContain(
		"secret-fixture-token",
	);
	await expect(
		finishGithubConnection("alice", state, "code"),
	).rejects.toThrow();
	expect(github.exchange).toHaveBeenCalledOnce();
});
it("rejects a different GitHub account even after a valid callback", async () => {
	github.profile.mockResolvedValueOnce({ data: { id: 456 } });
	const state =
		new URL(await startGithubConnection("alice")).searchParams.get("state") ??
		"";
	await expect(finishGithubConnection("alice", state, "code")).rejects.toThrow(
		"same GitHub account",
	);
});
it("rejects expired authorization state", async () => {
	const state =
		new URL(await startGithubConnection("alice")).searchParams.get("state") ??
		"";
	await db.exec(
		"update github_oauth_state set expires_at=now()-interval '1 second'",
	);
	await expect(
		finishGithubConnection("alice", state, "code"),
	).rejects.toThrow();
});
