import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	disconnectGithubConnection,
	finishGithubConnection,
	githubAccessToken,
	githubConnectionExists,
	startGithubConnection,
} from "../src/server/auth/github-connection";
import { seal, unseal } from "../src/server/auth/token-vault";

let db: PGlite;
const github = vi.hoisted(() => ({ exchange: vi.fn(), profile: vi.fn() }));
async function query(sql: string, params?: unknown[]) {
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
}
vi.mock("../src/server/adapters/github", () => ({
	exchangeGithubToken: github.exchange,
	githubClient: () => ({ users: { getAuthenticated: github.profile } }),
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query,
		connect: async () => ({
			query,
			release() {},
		}),
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
	await db.exec(`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),('carol','Carol','carol@example.test',true);
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
	await expect(
		finishGithubConnection("alice", state, "code"),
	).rejects.toMatchObject({ reason: "wrong-account" });
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
	).rejects.toMatchObject({ reason: "expired" });
});
it("lets email or Google users connect a GitHub account for repositories", async () => {
	github.profile.mockResolvedValueOnce({ data: { id: 789 } });
	const state =
		new URL(await startGithubConnection("carol")).searchParams.get("state") ??
		"";
	await finishGithubConnection("carol", state, "code");
	expect(await githubConnectionExists("carol")).toBe(true);
});
it("removes stored GitHub credentials on disconnect", async () => {
	const state =
		new URL(await startGithubConnection("alice")).searchParams.get("state") ??
		"";
	await finishGithubConnection("alice", state, "code");
	expect(await githubConnectionExists("alice")).toBe(true);
	await disconnectGithubConnection("alice");
	expect(await githubConnectionExists("alice")).toBe(false);
});

async function storeGithubCredentials(
	userId: string,
	credentials: {
		accessToken: string;
		refreshToken?: string;
		expiresAt: number | null;
	},
) {
	await db.query(
		"insert into github_connection(user_id,github_user_id,encrypted_credentials) values($1,$2,$3) on conflict(user_id) do update set encrypted_credentials=excluded.encrypted_credentials",
		[userId, "123", await seal(JSON.stringify(credentials))],
	);
}

it("returns the stored GitHub token when it is still valid", async () => {
	github.exchange.mockClear();
	await storeGithubCredentials("alice", {
		accessToken: "live-access-token",
		refreshToken: "live-refresh-token",
		expiresAt: Date.now() + 10 * 60 * 1000,
	});
	expect(await githubAccessToken("alice")).toBe("live-access-token");
	expect(github.exchange).not.toHaveBeenCalled();
});

it("rotates an expired GitHub token and stores the replacement", async () => {
	github.exchange.mockClear();
	github.exchange.mockResolvedValueOnce({
		accessToken: "rotated-access-token",
		refreshToken: "rotated-refresh-token",
		expiresAt: Date.now() + 60 * 60 * 1000,
	});
	await storeGithubCredentials("alice", {
		accessToken: "expired-access-token",
		refreshToken: "expired-refresh-token",
		expiresAt: Date.now() - 1000,
	});
	expect(await githubAccessToken("alice")).toBe("rotated-access-token");
	expect(github.exchange).toHaveBeenCalledWith({
		grant_type: "refresh_token",
		refresh_token: "expired-refresh-token",
	});
	const stored = await db.query<{ encrypted_credentials: string }>(
		"select encrypted_credentials from github_connection where user_id='alice'",
	);
	expect(stored.rows[0].encrypted_credentials).not.toContain(
		"rotated-access-token",
	);
	expect(
		JSON.parse(await unseal(stored.rows[0].encrypted_credentials)),
	).toEqual({
		accessToken: "rotated-access-token",
		refreshToken: "rotated-refresh-token",
		expiresAt: expect.any(Number),
	});
});

it("asks the user to reconnect GitHub when refresh is impossible", async () => {
	await storeGithubCredentials("alice", {
		accessToken: "expired-access-token",
		expiresAt: Date.now() - 1000,
	});
	await expect(githubAccessToken("alice")).rejects.toMatchObject({
		status: 409,
	});
	await db.query("delete from github_connection where user_id='alice'");
	await expect(githubAccessToken("alice")).rejects.toMatchObject({
		status: 409,
	});
});
