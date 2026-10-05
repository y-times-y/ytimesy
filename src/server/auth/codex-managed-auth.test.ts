import { afterEach, expect, it, vi } from "vitest";
import { refreshManagedCodexAuth } from "./codex-managed-auth";

vi.mock("../adapters/database", () => ({ database: vi.fn() }));
vi.mock("./token-vault", () => ({ seal: vi.fn(), unseal: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

function accessToken(
	accountId = "account",
	expiresAt = Date.now() + 3_600_000,
) {
	return `header.${Buffer.from(
		JSON.stringify({
			exp: Math.floor(expiresAt / 1000),
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
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
			redirect: "error",
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
	await expect(refreshManagedCodexAuth(auth)).rejects.toThrow(
		"Codex login refresh failed; reconnect Codex.",
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
	await expect(refreshManagedCodexAuth(auth)).rejects.toThrow(
		"Codex login refresh failed; reconnect Codex.",
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
