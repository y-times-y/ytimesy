import { afterEach, expect, it, vi } from "vitest";
import { CodexReconnectRequired } from "#/domain/api-turn-failure";
import { database } from "../adapters/database";
import {
	codexExternalTokens,
	refreshManagedCodexAuth,
} from "./codex-managed-auth";
import { seal, unseal } from "./token-vault";

vi.mock("../adapters/database", () => ({ database: vi.fn() }));
vi.mock("./token-vault", () => ({ seal: vi.fn(), unseal: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

function accessToken(
	accountId = "account",
	expiresAt = Date.now() + 3_600_000,
	planType?: string,
) {
	return `header.${Buffer.from(
		JSON.stringify({
			exp: Math.floor(expiresAt / 1000),
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
				...(planType ? { chatgpt_plan_type: planType } : {}),
			},
		}),
	).toString("base64url")}.signature`;
}

const auth = {
	auth_mode: "chatgpt" as const,
	tokens: {
		access_token: "old-access-token",
		refresh_token: "old-refresh-token",
		account_id: "account",
		id_token: "old-id-token",
	},
};

it("refreshes over the fixed native OAuth endpoint without invoking a CLI", async () => {
	const token = accessToken();
	const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
		Response.json({
			access_token: token,
			refresh_token: "rotated-refresh-token",
			id_token: "updated-id-token",
		}),
	);
	vi.stubGlobal("fetch", fetch);
	const updated = await refreshManagedCodexAuth(auth);
	expect(updated.tokens).toEqual({
		access_token: token,
		refresh_token: "rotated-refresh-token",
		account_id: "account",
		id_token: "updated-id-token",
	});
	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch).toHaveBeenCalledWith(
		"https://auth.openai.com/oauth/token",
		expect.objectContaining({
			method: "POST",
			redirect: "manual",
			signal: expect.any(AbortSignal),
		}),
	);
	const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
	expect(JSON.parse(String(init?.body))).toEqual({
		grant_type: "refresh_token",
		refresh_token: "old-refresh-token",
		client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
	});
});

it("retains credentials when the service does not rotate optional tokens", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ access_token: accessToken() })),
	);
	const updated = await refreshManagedCodexAuth(auth);
	expect(updated.tokens.refresh_token).toBe(auth.tokens.refresh_token);
	expect(updated.tokens.id_token).toBe(auth.tokens.id_token);
});

it("does not expose rejection bodies or retry a potentially rotated grant", async () => {
	const fetch = vi.fn(
		async () => new Response("private server diagnostics", { status: 401 }),
	);
	vi.stubGlobal("fetch", fetch);
	await expect(refreshManagedCodexAuth(auth)).rejects.toBeInstanceOf(
		CodexReconnectRequired,
	);
	expect(fetch).toHaveBeenCalledOnce();
});

it.each([
	["malformed JSON", "{"],
	["invalid credentials", JSON.stringify({ access_token: 42 })],
	["oversized response", "x".repeat(65_537)],
])("rejects %s without exposing response contents", async (_name, body) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body)),
	);
	await expect(refreshManagedCodexAuth(auth)).rejects.toThrow(
		"Codex login refresh returned incomplete credentials.",
	);
});

it("rejects expired access tokens", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				access_token: accessToken("account", Date.now() - 1000),
			}),
		),
	);
	await expect(refreshManagedCodexAuth(auth)).rejects.toBeInstanceOf(
		CodexReconnectRequired,
	);
});

it("rejects an access token for a different ChatGPT account", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ access_token: accessToken("other-account") }),
		),
	);
	await expect(refreshManagedCodexAuth(auth)).rejects.toThrow(
		"Codex login account changed; reconnect Codex.",
	);
});

it("treats only definitive grant rejections as requiring sign-in", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 503 })),
	);
	await expect(refreshManagedCodexAuth(auth)).rejects.toThrow(
		"temporarily unavailable",
	);
	await expect(refreshManagedCodexAuth(auth)).rejects.not.toBeInstanceOf(
		CodexReconnectRequired,
	);
});

function storedAccount(stored: object) {
	const queries: Array<{ sql: string; values?: unknown[] }> = [];
	const client = {
		query: vi.fn(async (sql: string, values?: unknown[]) => {
			queries.push({ sql, values });
			return sql.startsWith("select")
				? { rows: [{ encrypted_codex_auth: "sealed" }] }
				: { rows: [] };
		}),
		release: vi.fn(),
	};
	vi.mocked(database).mockReturnValue({
		connect: vi.fn(async () => client),
		query: client.query,
	} as never);
	vi.mocked(unseal).mockResolvedValue(JSON.stringify(stored));
	vi.mocked(seal).mockResolvedValue("resealed");
	return queries;
}

it("commits an expired account state when the refresh grant is rejected", async () => {
	const queries = storedAccount(auth);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 401 })),
	);
	await expect(codexExternalTokens("owner", true)).rejects.toBeInstanceOf(
		CodexReconnectRequired,
	);
	const statements = queries.map((query) => query.sql);
	const expired = statements.findIndex((sql) =>
		sql.includes("status='expired'"),
	);
	expect(expired).toBeGreaterThan(-1);
	expect(statements[expired + 1]).toBe("commit");
	expect(
		statements.some((sql) => sql.includes("encrypted_codex_auth=$2")),
	).toBe(false);
});

it("keeps a transient refresh failure from expiring the account", async () => {
	const queries = storedAccount(auth);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 502 })),
	);
	await expect(codexExternalTokens("owner", true)).rejects.toThrow(
		"temporarily unavailable",
	);
	expect(queries.some((query) => query.sql.includes("status='expired'"))).toBe(
		false,
	);
});

it("records the plan carried by a refreshed token", async () => {
	const queries = storedAccount(auth);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				access_token: accessToken("account", Date.now() + 3_600_000, "free"),
			}),
		),
	);
	await codexExternalTokens("owner", true);
	const update = queries.find((query) => query.sql.includes("plan_type="));
	expect(update?.values).toEqual(["owner", "resealed", "free"]);
});

it("reads a fresh token without locking the account row", async () => {
	const fresh = {
		...auth,
		tokens: { ...auth.tokens, access_token: accessToken() },
	};
	const queries = storedAccount(fresh);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(await codexExternalTokens("owner")).toEqual({
		accessToken: fresh.tokens.access_token,
		chatgptAccountId: "account",
	});
	expect(queries.map((query) => query.sql)).toEqual([
		expect.stringMatching(/^select encrypted_codex_auth .*status='connected'$/),
	]);
	expect(vi.mocked(database)().connect).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("refreshes a token near expiry under the row lock", async () => {
	const expiring = {
		...auth,
		tokens: {
			...auth.tokens,
			access_token: accessToken("account", Date.now() + 60_000),
		},
	};
	const queries = storedAccount(expiring);
	const refreshed = accessToken("account", Date.now() + 3_600_000);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ access_token: refreshed })),
	);
	expect((await codexExternalTokens("owner")).accessToken).toBe(refreshed);
	const statements = queries.map((query) => query.sql);
	expect(statements).toContain("begin");
	expect(statements.some((sql) => sql.endsWith("for update"))).toBe(true);
	expect(statements.at(-1)).toBe("commit");
});

function delegatedAccount(stored: object) {
	const queries: Array<{ sql: string; values?: unknown[] }> = [];
	const query = vi.fn(async (sql: string, values?: unknown[]) => {
		queries.push({ sql, values });
		if (sql.includes("from dev_eval_user"))
			return {
				rows: values?.[0] === "eval-user" ? [{ owner_user_id: "owner" }] : [],
			};
		return sql.startsWith("select")
			? { rows: [{ encrypted_codex_auth: "sealed" }] }
			: { rows: [] };
	});
	vi.mocked(database).mockReturnValue({
		connect: vi.fn(async () => ({ query, release: vi.fn() })),
		query,
	} as never);
	vi.mocked(unseal).mockResolvedValue(JSON.stringify(stored));
	return queries;
}

it("serves a development eval user from its owner's login row", async () => {
	vi.stubEnv("YTIMESY_DEV_EVAL_USERS", "1");
	vi.stubEnv("YTIMESY_ENVIRONMENT", "development");
	try {
		const queries = delegatedAccount({
			...auth,
			tokens: { ...auth.tokens, access_token: accessToken() },
		});
		await expect(codexExternalTokens("eval-user")).resolves.toMatchObject({
			chatgptAccountId: "account",
		});
		const account = queries.find((query) =>
			query.sql.includes("from agent_account"),
		);
		expect(account?.values).toEqual(["owner"]);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("never reads eval users outside development or without the switch", async () => {
	for (const env of [
		{},
		{ YTIMESY_ENVIRONMENT: "production" },
		// Unset (or any other value) is not development.
		{ YTIMESY_ENVIRONMENT: "" },
	]) {
		vi.stubEnv("YTIMESY_DEV_EVAL_USERS", "1");
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		if (!Object.keys(env).length) vi.stubEnv("YTIMESY_DEV_EVAL_USERS", "");
		try {
			const queries = delegatedAccount({
				...auth,
				tokens: { ...auth.tokens, access_token: accessToken() },
			});
			await codexExternalTokens("eval-user");
			expect(queries.some((query) => query.sql.includes("dev_eval_user"))).toBe(
				false,
			);
			expect(queries[0]?.values).toEqual(["eval-user"]);
		} finally {
			vi.unstubAllEnvs();
		}
	}
});
