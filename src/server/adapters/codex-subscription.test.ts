import { beforeEach, expect, it, vi } from "vitest";
import {
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
