import { generateText } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import {
	codexSubscriptionCatalog,
	codexSubscriptionModel,
	readCodexSubscriptionUsage,
	subscriptionLimits,
} from "./codex-subscription";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connected: vi.fn() }));
vi.mock("../auth/codex-managed-auth", () => ({
	codexExternalTokens: mocks.auth,
	hasManagedCodexAuth: mocks.connected,
}));
beforeEach(() => {
	vi.restoreAllMocks();
	mocks.auth.mockReset().mockImplementation(async (userId: string) => ({
		accessToken: `token-${userId}`,
		chatgptAccountId: `account-${userId}`,
	}));
	mocks.connected.mockReset().mockResolvedValue(true);
});

it("keeps subscription cache routing stable per account and chat through the real SDK", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url) => {
			if (String(url).includes("/models"))
				return new Response(
					JSON.stringify({
						models: [{ slug: "cached-model", context_window: 272000 }],
					}),
				);
			throw new Error("fixture-stop");
		});
	const runtime = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-one",
	);
	const same = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-one",
	);
	const other = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-two",
	);
	const settings = runtime.requestSettings("instructions");
	const key = settings.providerOptions.openai.promptCacheKey;
	expect(key).toMatch(/^[a-f0-9]{64}$/);
	expect(
		same.requestSettings("instructions").providerOptions.openai.promptCacheKey,
	).toBe(key);
	expect(
		other.requestSettings("instructions").providerOptions.openai.promptCacheKey,
	).not.toBe(key);
	await expect(
		generateText({
			model: runtime.model,
			prompt: "unchanged",
			maxRetries: 0,
			...settings,
		}),
	).rejects.toThrow("fixture-stop");
	const request = fetch.mock.calls.at(-1)?.[1];
	expect(new Headers(request?.headers).get("session-id")).toBe(key);
	expect(JSON.parse(request?.body as string).prompt_cache_key).toBe(key);
	mocks.auth.mockResolvedValue({
		accessToken: "different-account-token",
		chatgptAccountId: "different-account",
	});
	await expect(
		generateText({
			model: runtime.model,
			prompt: "unchanged",
			maxRetries: 0,
			...settings,
		}),
	).rejects.toThrow("account changed");
});

it("uses the account catalog and requested reasoning without advertising unsupported fast mode", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [
					{
						slug: "modern",
						display_name: "Modern Model",
						context_window: 272000,
						auto_compact_token_limit: null,
						supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
						default_reasoning_level: "low",
					},
				],
			}),
		),
	);
	const models = await codexSubscriptionCatalog("reasoning-owner");
	expect(models[0].label).toBe("Modern Model");
	expect(models[0].supportsFastMode).toBeUndefined();
	const runtime = await codexSubscriptionModel(
		"reasoning-owner",
		"modern",
		"high",
	);
	expect(runtime.contextWindow).toBe(272000);
	expect(runtime.workingContextTokens).toBe(64_000);
	expect(runtime.coordinationWorkingContextTokens).toBe(48_000);
	expect(runtime.autoCompactTokenLimit).toBeUndefined();
	expect(runtime.compact).toBeTypeOf("function");
	expect(
		runtime.requestSettings("instructions").providerOptions.openai
			.reasoningEffort,
	).toBe("high");
	await expect(
		codexSubscriptionModel("reasoning-owner", "modern", "ultra"),
	).rejects.toThrow("reasoning");
	await expect(
		codexSubscriptionModel("reasoning-owner", "modern", "low", true),
	).rejects.toThrow("Fast mode");
	mocks.connected.mockResolvedValue(false);
	await expect(codexSubscriptionCatalog("reasoning-owner")).rejects.toThrow(
		"Connect Codex",
	);
});
const window = {
	used_percent: 29,
	limit_window_seconds: 604800,
	reset_at: 123456,
};
it("normalizes account windows, preserves reset time and missing secondary window", () => {
	expect(
		subscriptionLimits(
			{ rate_limit: { primary_window: window, secondary_window: null } },
			1000,
		),
	).toEqual({
		updatedAt: 1,
		limits: {
			rateLimitsByLimitId: {
				codex: {
					limitId: "codex",
					limitName: undefined,
					primary: {
						usedPercent: 29,
						windowDurationMins: 10080,
						resetsAt: 123456,
					},
					secondary: null,
				},
			},
		},
	});
});
it("rejects malformed percentages instead of inventing usage", () => {
	expect(() =>
		subscriptionLimits({
			rate_limit: { primary_window: { ...window, used_percent: 101 } },
		}),
	).toThrow();
});
it("scopes every metadata request to its authenticated owner and returns no secrets", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ rate_limit: { primary_window: window } }),
				),
		);
	const usage = await readCodexSubscriptionUsage("alice");
	expect(fetch).toHaveBeenCalledWith(
		"https://chatgpt.com/backend-api/wham/usage",
		expect.objectContaining({
			headers: {
				Authorization: "Bearer token-alice",
				"ChatGPT-Account-ID": "account-alice",
			},
			redirect: "error",
		}),
	);
	expect(JSON.stringify(usage)).not.toContain("token-alice");
	await readCodexSubscriptionUsage("bob");
	expect(mocks.auth).toHaveBeenLastCalledWith("bob");
});
it("does not query the provider for disconnected users", async () => {
	mocks.connected.mockResolvedValue(false);
	expect(await readCodexSubscriptionUsage("alice")).toBeUndefined();
	expect(mocks.auth).not.toHaveBeenCalled();
});
it("does not silently use another model when the catalog has no match", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [{ slug: "different", context_window: 272000 }],
			}),
		),
	);
	await expect(codexSubscriptionModel("alice", "selected")).rejects.toThrow(
		"unavailable",
	);
});
