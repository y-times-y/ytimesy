import { beforeEach, expect, it, vi } from "vitest";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import { failoverConnections, pinnedTurnFailover } from "./model-failover";

const OPENROUTER = "11111111-1111-4111-8111-111111111111";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), auth: vi.fn() }));

vi.mock("../adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: async () => ({
		enabled: true,
		askBeforePaid: true,
		connectionOrder: [],
	}),
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("../adapters/codex-subscription", () => ({
	codexSubscriptionCatalog: mocks.catalog,
}));
vi.mock("../adapters/browse-models", () => ({ browseModels: async () => [] }));
vi.mock("../adapters/model-connections", () => ({
	listModelConnections: async () => [
		{
			id: "11111111-1111-4111-8111-111111111111",
			provider: "openrouter",
			label: "OpenRouter",
			baseUrl: "https://openrouter.ai/api/v1",
			revision: "or-rev",
			models: [
				{
					id: "openai/gpt-6.1-sol",
					label: "openai/gpt-6.1-sol",
					toolStreamingVerified: true,
				},
			],
		},
	],
}));

beforeEach(() => {
	mocks.auth.mockResolvedValue(true);
	mocks.catalog.mockResolvedValue([
		{
			id: "gpt-6.1-sol",
			label: "GPT-6.1-Sol",
			reasoning: {
				levels: [{ id: "high", label: "high" }],
				defaultLevelId: "high",
			},
		},
	]);
});

it("lists Codex even while its catalog is down, so the chosen model still maps", async () => {
	mocks.catalog.mockRejectedValueOnce(new Error("503"));
	const connections = await failoverConnections("owner");
	expect(connections.map((row) => [row.key, row.models.length])).toEqual([
		["codex", 0],
		[OPENROUTER, 1],
	]);
});

it("pins an approved fallback for the follow-up turn, whatever the paid-key setting", async () => {
	const original = {
		connectionId: null,
		connectionRevision: subscriptionTurnRevision("high", false),
		modelId: "gpt-6.1-sol",
	};
	const pinned = await pinnedTurnFailover(
		"owner",
		original,
		`${OPENROUTER}|openai/gpt-6.1-sol`,
	);
	expect(pinned).toMatchObject({
		route: { connectionId: OPENROUTER, modelId: "openai/gpt-6.1-sol" },
		label: { model: "GPT-6.1 Sol", connection: "OpenRouter" },
		tried: ["codex|gpt-6.1-sol", `${OPENROUTER}|openai/gpt-6.1-sol`],
		switches: 1,
	});
	await expect(
		pinnedTurnFailover("owner", original, "codex|gpt-6.1-sol"),
	).rejects.toThrow("no longer available");
});

import { apiFailoverConnections } from "./model-failover";

it("offers a SuperGrok subscription as a prepaid fallback only while it is ready", () => {
	const supergrok = {
		id: "00000000-0000-4000-8000-0000000000a1",
		provider: "compatible" as const,
		label: "SuperGrok",
		baseUrl: "https://api.x.ai/v1",
		revision: "sg-rev",
		models: [
			{ id: "grok-4.7", label: "Grok 4.7", toolStreamingVerified: false },
		],
		subscription: { provider: "xai" as const, status: "ready" as const },
	};
	const [ready] = apiFailoverConnections([supergrok], []);
	expect(ready).toMatchObject({ kind: "plan", label: "SuperGrok" });
	expect(ready.models.map((model) => model.id)).toEqual(["grok-4.7"]);
	const [waiting] = apiFailoverConnections(
		[
			{
				...supergrok,
				subscription: { provider: "xai", status: "reconnect" },
			},
		],
		[],
	);
	expect(waiting.models).toEqual([]);
});
