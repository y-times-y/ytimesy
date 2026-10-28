import { createHmac } from "node:crypto";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const SECRET = "s".repeat(32);
const store = vi.hoisted(() => ({
	tables: {} as Record<string, Record<string, unknown>[]>,
	adapter: undefined as unknown,
	queries: [] as string[],
}));
vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		APP_URL: "http://127.0.0.1:3000",
		BETTER_AUTH_SECRET: "s".repeat(32),
		GITHUB_OAUTH_CLIENT_ID: "id",
		GITHUB_OAUTH_CLIENT_SECRET: "secret",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});
// Better Auth runs on its in-memory adapter; account deletion's SQL is recorded.
vi.mock("../src/server/adapters/database", () => ({
	database: () => store.adapter,
}));

import { auth, readSession, requireUser } from "../src/server/auth/auth";
import {
	cachedSession,
	forgetAllSessions,
	rememberSession,
	SESSION_CACHE_TTL_MS,
	sessionCacheKey,
} from "../src/server/auth/session-cache";

function resetStore() {
	store.tables = {
		auth_user: [],
		auth_session: [],
		auth_account: [],
		auth_verification: [],
		auth_rate_limit: [],
	};
	const adapter = memoryAdapter(store.tables);
	// account deletion talks SQL to the same "database"
	Object.assign(adapter, {
		connect: async () => ({
			query: async (sql: string, params: unknown[]) => {
				store.queries.push(sql);
				if (sql.startsWith("delete from auth_user")) {
					const id = params[0];
					store.tables.auth_user = store.tables.auth_user.filter(
						(row) => row.id !== id,
					);
					store.tables.auth_session = store.tables.auth_session.filter(
						(row) => row.userId !== id,
					);
					return { rows: [{ id }], rowCount: 1 };
				}
				return { rows: [], rowCount: 0 };
			},
			release() {},
		}),
	});
	store.adapter = adapter;
}

async function signedIn(email = "ada@example.test") {
	const context = await auth().$context;
	const user = await context.internalAdapter.createUser(
		{ email, name: "Ada", emailVerified: true },
		undefined as never,
	);
	const session = await context.internalAdapter.createSession(user.id);
	const signature = createHmac("sha256", SECRET)
		.update(session.token)
		.digest("base64");
	const headers = new Headers({
		cookie: `theme=dark; better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
	});
	return { user, session, headers, context };
}

let lookups: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	resetStore();
	forgetAllSessions();
	store.queries = [];
	lookups = vi.spyOn(auth().api, "getSession");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("keys on the session cookie only, signature included", () => {
	const key = sessionCacheKey(
		new Headers({ cookie: "a=1; better-auth.session_token=t.sig; b=2" }),
	);
	expect(key).toBe("better-auth.session_token=t.sig");
	expect(
		sessionCacheKey(
			new Headers({ cookie: "__Secure-better-auth.session_token=t.sig" }),
		),
	).toBe("__Secure-better-auth.session_token=t.sig");
	expect(sessionCacheKey(new Headers({ cookie: "a=1" }))).toBeNull();
	expect(sessionCacheKey(new Headers())).toBeNull();
});

it("answers repeat calls with the same cookie from memory", async () => {
	const { user, headers } = await signedIn();
	expect((await requireUser(headers)).id).toBe(user.id);
	expect((await requireUser(headers)).id).toBe(user.id);
	expect((await readSession(headers))?.user.id).toBe(user.id);
	expect(lookups).toHaveBeenCalledTimes(1);
});

it("never caches a refusal, and a tampered signature is not a hit", async () => {
	const { headers, session } = await signedIn();
	const forged = new Headers({
		cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.forged`)}`,
	});
	await expect(requireUser(forged)).rejects.toBeInstanceOf(Response);
	await requireUser(headers);
	await expect(requireUser(forged)).rejects.toBeInstanceOf(Response);
	expect(lookups).toHaveBeenCalledTimes(3);
});

it("re-checks the database once the TTL passes", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const { headers } = await signedIn();
	await requireUser(headers);
	vi.setSystemTime(Date.now() + SESSION_CACHE_TTL_MS - 1);
	await requireUser(headers);
	expect(lookups).toHaveBeenCalledTimes(1);
	vi.setSystemTime(Date.now() + 2);
	await requireUser(headers);
	expect(lookups).toHaveBeenCalledTimes(2);
});

it("signing out ends the cached session at once", async () => {
	const { headers } = await signedIn();
	await requireUser(headers);
	await auth().api.signOut({ headers });
	await expect(requireUser(headers)).rejects.toBeInstanceOf(Response);
});

it("revoking every session (password reset) ends the cached session at once", async () => {
	const { headers, user, context } = await signedIn();
	await requireUser(headers);
	await context.internalAdapter.deleteUserSessions(user.id);
	await expect(requireUser(headers)).rejects.toBeInstanceOf(Response);
});

it("revoking one session leaves the user's other sessions cached", async () => {
	const first = await signedIn();
	const session = await first.context.internalAdapter.createSession(
		first.user.id,
	);
	const signature = createHmac("sha256", SECRET)
		.update(session.token)
		.digest("base64");
	const other = new Headers({
		cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
	});
	await requireUser(first.headers);
	await requireUser(other);
	await first.context.internalAdapter.deleteSession(first.session.token);
	await expect(requireUser(first.headers)).rejects.toBeInstanceOf(Response);
	expect((await requireUser(other)).id).toBe(first.user.id);
	expect(lookups).toHaveBeenCalledTimes(3);
});

it("deleting the account ends its cached sessions at once", async () => {
	const { deleteAccountRecords } = await import(
		"../src/server/adapters/account-deletion"
	);
	const { headers, user } = await signedIn();
	await requireUser(headers);
	await deleteAccountRecords(user.id);
	expect(store.queries).toContain("commit");
	await expect(requireUser(headers)).rejects.toBeInstanceOf(Response);
});

it("never serves a session past its own expiry", () => {
	const now = Date.UTC(2026, 9, 26);
	const value = {
		session: { token: "t", expiresAt: new Date(now + 1_000) },
		user: { id: "u" },
	};
	rememberSession("k", value, now);
	expect(cachedSession("k", now + 999)).toBe(value);
	expect(cachedSession("k", now + 1_000)).toBeUndefined();
	rememberSession(
		"expired",
		{ ...value, session: { token: "t", expiresAt: new Date(now - 1) } },
		now,
	);
	expect(cachedSession("expired", now)).toBeUndefined();
});
