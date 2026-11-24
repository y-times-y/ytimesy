import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	settings: vi.fn(),
	failover: vi.fn(),
	codexAuth: vi.fn(),
	codexCatalog: vi.fn(),
	codexUsage: vi.fn(),
	apiCatalog: vi.fn(),
	connections: vi.fn(),
	claude: vi.fn(),
	spent: vi.fn(),
}));
vi.mock("../adapters/y-squared-crew-client", () => ({
	ySquaredCrewFor: () => ({ proactive: mocks.settings }),
}));
vi.mock("../adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: mocks.failover,
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.codexAuth,
}));
vi.mock("../adapters/codex-subscription", () => ({
	codexSubscriptionCatalog: mocks.codexCatalog,
	readCodexSubscriptionUsage: mocks.codexUsage,
}));
vi.mock("./api-workspace-session", () => ({
	apiModelCatalog: mocks.apiCatalog,
}));
vi.mock("../adapters/model-connections", () => ({
	listModelConnections: mocks.connections,
}));
vi.mock("../adapters/claude-subscription", () => ({
	claudeSubscriptionStatus: mocks.claude,
}));
vi.mock("../adapters/plan-spent", () => ({ planSpentUntil: mocks.spent }));

import { codexPlanState, ySquaredThreadModels } from "./y-squared-models";

const CONNECTION = "6c1f6a52-4f1e-4d1b-9a7e-3f2d9b1c0a11";
const NOW = Date.now();

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.settings.mockResolvedValue({ settings: { modelChoice: true } });
	mocks.failover.mockResolvedValue({ enabled: true });
	mocks.codexAuth.mockResolvedValue(true);
	mocks.codexCatalog.mockResolvedValue([
		{
			id: "gpt-6.2-sol",
			label: "GPT-6.2 Sol",
			reasoning: {
				levels: [
					{ id: "low", label: "Low" },
					{ id: "high", label: "High" },
				],
				defaultLevelId: "low",
			},
			speeds: [{ id: "fast" }],
		},
		{ id: "gpt-6-luna", label: "GPT-6 Luna" },
	]);
	mocks.codexUsage.mockResolvedValue(undefined);
	mocks.apiCatalog.mockResolvedValue([
		{ id: "claude-code/claude-opus-5-5", label: "Claude Opus 5.5" },
		{
			id: `api/${CONNECTION}/x-ai%2Fgrok-4.7`,
			label: "Grok 4.7 · My Grok",
		},
	]);
	mocks.connections.mockResolvedValue([
		{
			id: CONNECTION,
			label: "My Grok",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			subscription: { status: "ready" },
			models: [],
		},
	]);
	mocks.claude.mockResolvedValue({ status: "connected" });
	mocks.spent.mockResolvedValue(null);
});

describe("the models Y² can choose from", () => {
	it("lists every connected route with its runtime, route and tier", async () => {
		const choices = await ySquaredThreadModels("u", "p");
		expect(choices).toMatchObject({ enabled: true, failover: true });
		expect(
			choices.models.map((m) => [m.id, m.harness, m.route, m.tier, m.usable]),
		).toEqual([
			["gpt-6.2-sol", "codex", "Codex (ChatGPT plan)", "frontier", true],
			["gpt-6-luna", "codex", "Codex (ChatGPT plan)", "fast", true],
			[
				"claude-code/claude-opus-5-5",
				"api",
				"Claude Agent (Claude plan)",
				"frontier",
				true,
			],
			[
				`api/${CONNECTION}/x-ai%2Fgrok-4.7`,
				"api",
				"My Grok (plan)",
				null,
				true,
			],
		]);
		const sol = choices.models[0];
		expect(sol?.reasoning).toEqual(["low", "high"]);
		expect(sol?.defaultReasoning).toBe("low");
		expect(sol?.speeds).toEqual(["fast"]);
	});

	it("a route that is not connected is not listed", async () => {
		mocks.codexAuth.mockResolvedValue(false);
		mocks.apiCatalog.mockResolvedValue([]);
		expect((await ySquaredThreadModels("u", "p")).models).toEqual([]);
	});

	it("a plan that is used up is listed as not usable, with when it resets", async () => {
		const until = NOW + 3_600_000;
		mocks.codexUsage.mockResolvedValue({
			limits: {
				rateLimitsByLimitId: {
					codex: {
						primary: { usedPercent: 100, resetsAt: Math.floor(until / 1000) },
						secondary: { usedPercent: 10, resetsAt: Math.floor(until / 1000) },
					},
				},
			},
		});
		mocks.spent.mockImplementation(async (_user, route) =>
			route.connectionId === null ? until : null,
		);
		const choices = await ySquaredThreadModels("u", "p");
		const byId = Object.fromEntries(choices.models.map((m) => [m.id, m]));
		expect(byId["gpt-6.2-sol"]).toMatchObject({ usable: false });
		expect(byId["gpt-6.2-sol"]?.unavailable).toContain("plan used up until");
		expect(byId["claude-code/claude-opus-5-5"]?.usable).toBe(false);
		expect(byId[`api/${CONNECTION}/x-ai%2Fgrok-4.7`]?.usable).toBe(true);
	});

	it("a plan close to its limit is usable but flagged", async () => {
		mocks.codexUsage.mockResolvedValue({
			limits: {
				rateLimitsByLimitId: {
					codex: { primary: { usedPercent: 95, resetsAt: NOW + 1e6 } },
				},
			},
		});
		const [first] = (await ySquaredThreadModels("u", "p")).models;
		expect(first).toMatchObject({ usable: true, nearlySpent: true });
	});

	it("keeps Codex models usable when only a feature-specific bucket is exhausted", async () => {
		mocks.codexUsage.mockResolvedValue({
			limits: {
				rateLimitsByLimitId: {
					codex: { primary: { usedPercent: 20, resetsAt: NOW + 1e6 } },
					code_review: { primary: { usedPercent: 100, resetsAt: NOW + 1e6 } },
				},
			},
		});
		const codex = (await ySquaredThreadModels("u", "p")).models.slice(0, 2);
		for (const model of codex) {
			expect(model.usable).toBe(true);
			expect(model.nearlySpent).toBeUndefined();
		}
	});

	it("a refused Claude sign-in or a plan waiting for sign-in is not usable", async () => {
		mocks.claude.mockResolvedValue({ status: "refused" });
		mocks.connections.mockResolvedValue([
			{
				id: CONNECTION,
				label: "My Grok",
				provider: "xai",
				baseUrl: "https://api.x.ai/v1",
				subscription: { status: "expired" },
				models: [],
			},
		]);
		const byId = Object.fromEntries(
			(await ySquaredThreadModels("u", "p")).models.map((m) => [m.id, m]),
		);
		expect(byId["claude-code/claude-opus-5-5"]?.unavailable).toContain(
			"sign-in needs renewing",
		);
		expect(byId[`api/${CONNECTION}/x-ai%2Fgrok-4.7`]?.usable).toBe(false);
	});

	it("carries the person's failover and model-choice settings", async () => {
		mocks.failover.mockResolvedValue({ enabled: false });
		mocks.settings.mockResolvedValue({ settings: { modelChoice: false } });
		expect(await ySquaredThreadModels("u", "p")).toMatchObject({
			enabled: false,
			failover: false,
		});
	});

	it("an unreadable setting or failover preference reads as on", async () => {
		mocks.failover.mockRejectedValue(new Error("db"));
		mocks.settings.mockRejectedValue(new Error("do"));
		expect(await ySquaredThreadModels("u", "p")).toMatchObject({
			enabled: true,
			failover: true,
		});
	});
});

describe("codexPlanState", () => {
	it("ignores expired windows for both spent and nearly spent state", () => {
		const usage = (primary: unknown, secondary?: unknown) => ({
			limits: { rateLimitsByLimitId: { codex: { primary, secondary } } },
		});
		for (const usedPercent of [90, 95, 100, 120]) {
			expect(
				codexPlanState(usage({ usedPercent, resetsAt: NOW - 1 }), NOW),
			).toEqual({ spentUntil: null, nearly: false });
		}
		expect(
			codexPlanState(usage({ usedPercent: 100, resetsAt: NOW }), NOW),
		).toEqual({ spentUntil: null, nearly: false });
		expect(
			codexPlanState(
				usage(
					{ usedPercent: 100, resetsAt: Math.floor(NOW / 1000) - 1 },
					{ usedPercent: 93, resetsAt: NOW + 120_000 },
				),
				NOW,
			),
		).toEqual({ spentUntil: null, nearly: true });
	});

	it("only uses the global codex bucket for spent and nearly spent state", () => {
		const usage = (codex: unknown, featurePercent: number) => ({
			limits: {
				rateLimitsByLimitId: {
					...(codex ? { codex } : {}),
					review: {
						primary: { usedPercent: featurePercent, resetsAt: NOW + 2e6 },
					},
				},
			},
		});
		expect(
			codexPlanState(usage({ primary: { usedPercent: 15 } }, 100), NOW),
		).toEqual({ spentUntil: null, nearly: false });
		expect(
			codexPlanState(usage({ primary: { usedPercent: 15 } }, 95), NOW),
		).toEqual({ spentUntil: null, nearly: false });
		expect(codexPlanState(usage(undefined, 100), NOW)).toEqual({
			spentUntil: null,
			nearly: false,
		});
		expect(
			codexPlanState(
				usage(
					{
						primary: { usedPercent: 20 },
						secondary: { usedPercent: 100, resetsAt: NOW + 1e6 },
					},
					100,
				),
				NOW,
			),
		).toEqual({ spentUntil: NOW + 1e6, nearly: false });
	});

	it("reads reset times in seconds or milliseconds and ignores a window that already reset", () => {
		const bucket = (usedPercent: number, resetsAt: number) => ({
			limits: {
				rateLimitsByLimitId: { codex: { primary: { usedPercent, resetsAt } } },
			},
		});
		const seconds = Math.floor(NOW / 1000) + 600;
		expect(codexPlanState(bucket(100, seconds), NOW).spentUntil).toBe(
			seconds * 1000,
		);
		expect(codexPlanState(bucket(100, NOW + 600_000), NOW).spentUntil).toBe(
			NOW + 600_000,
		);
		expect(codexPlanState(bucket(100, NOW / 1000 - 600), NOW).spentUntil).toBe(
			null,
		);
		expect(codexPlanState(undefined, NOW)).toEqual({
			spentUntil: null,
			nearly: false,
		});
	});
});
