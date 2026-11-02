import { describe, expect, it } from "vitest";
import { API_MODEL_LIST, apiModelSections } from "./api-model-list";
import {
	availableConnectionModels,
	connectionModels,
	isCustomConnection,
	modelConnectionInput,
	type PublicModelConnection,
} from "./model-connection";
import {
	apiPickerSections,
	connectionKeyChoice,
	directKeyProvider,
	keyChoiceConnection,
	keyChoiceLabel,
	keyProviderChoices,
	providerConnections,
	providerKeyConnection,
	selectedProviderConnection,
} from "./provider-access";

describe("provider-level access", () => {
	it("routes gateway keys to the gateway regardless of the selected provider", () => {
		for (const author of ["google", "openai", "qwen"]) {
			expect(providerKeyConnection(author, " sk-or-test-only ")).toEqual({
				provider: "openrouter",
				label: "OpenRouter",
				apiKey: "sk-or-test-only",
			});
		}
	});
	it("keeps direct keys scoped to the selected provider", () => {
		expect(providerKeyConnection("x-ai", "test-only")).toEqual({
			provider: "compatible",
			label: "xAI",
			apiKey: "test-only",
			baseUrl: "https://api.x.ai/v1",
		});
		expect(providerKeyConnection("google", "test-only").provider).toBe(
			"google",
		);
		// No listed model runs on these makers' own APIs, so their keys unlock nothing.
		expect(() => providerKeyConnection("deepseek", "test-only")).toThrow(
			"not supported",
		);
		expect(() => providerKeyConnection("meta", "test-only")).toThrow(
			"not supported",
		);
		expect(() => providerKeyConnection("qwen", "test-only")).toThrow(
			"not supported",
		);
	});
	it("shares gateway access but not other providers' direct connections", () => {
		const connections = [
			{ id: "or", provider: "openrouter" },
			{ id: "google", provider: "google" },
			{ id: "openai", provider: "openai" },
			{
				id: "deepseek",
				provider: "compatible",
				baseUrl: "https://api.deepseek.com",
			},
		] as PublicModelConnection[];
		expect(
			providerConnections("google", connections).map((row) => row.id),
		).toEqual(["or", "google"]);
		expect(
			providerConnections("deepseek", connections).map((row) => row.id),
		).toEqual(["or", "deepseek"]);
	});
	it("uses the saved route until the user explicitly chooses another key", () => {
		const gatewayId = "11111111-1111-4111-8111-111111111111";
		const directId = "22222222-2222-4222-8222-222222222222";
		const connections = [
			{ id: gatewayId, provider: "openrouter", label: "OpenRouter" },
			{ id: directId, provider: "google", label: "Google" },
		] as PublicModelConnection[];
		const route = `api/${gatewayId}/google%2Fgemini`;
		expect(
			selectedProviderConnection(
				providerConnections("google", connections),
				route,
			)?.id,
		).toBe(gatewayId);
		expect(
			selectedProviderConnection(
				providerConnections("google", connections),
				route,
				directId,
			)?.id,
		).toBe(directId);
		expect(
			selectedProviderConnection(
				providerConnections("openai", connections),
				route,
				directId,
			)?.id,
		).toBe(gatewayId);
	});
});

describe("custom OpenAI-compatible endpoints", () => {
	const custom = {
		id: "33333333-3333-4333-8333-333333333333",
		provider: "compatible",
		label: "Company gateway",
		baseUrl: "https://llm.example.com/v1",
		revision: "r",
		models: [
			{ id: "llama-4-70b", label: "llama-4-70b", toolStreamingVerified: true },
		],
	} as PublicModelConnection;
	const xai = {
		...custom,
		id: "44444444-4444-4444-8444-444444444444",
		baseUrl: "https://api.x.ai/v1",
		models: [
			{ id: "grok-legacy", label: "grok-legacy", toolStreamingVerified: true },
		],
	} as PublicModelConnection;

	it("offers every model the endpoint lists under Custom", () => {
		expect(apiPickerSections([custom]).at(-1)).toBe("custom");
		expect(apiPickerSections([xai])).not.toContain("custom");
		expect(
			providerConnections("custom", [custom, xai]).map((row) => row.id),
		).toEqual([custom.id]);
		expect(connectionModels(custom, []).map((model) => model.id)).toEqual([
			"llama-4-70b",
		]);
	});

	it("keeps a known maker's host on the curated list", () => {
		expect(isCustomConnection(xai)).toBe(false);
		expect(connectionModels(xai, [])).toEqual([]);
		expect(
			isCustomConnection({
				...custom,
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		).toBe(false);
	});
});

describe("Settings key choices", () => {
	const choices = keyProviderChoices();
	const makers = choices
		.map((row) => row.id)
		.filter((id) => id !== "openrouter" && id !== "custom");

	it("offers every catalog maker whose own key unlocks a listed model, then OpenRouter and Custom", () => {
		expect(choices.map((row) => row.id)).toEqual([
			"openai",
			"anthropic",
			"google",
			"x-ai",
			"openrouter",
			"custom",
		]);
		for (const author of apiModelSections())
			expect(makers.includes(author)).toBe(directKeyProvider(author) !== null);
		expect(keyChoiceLabel("x-ai")).toBe("xAI");
		expect(choices.find((row) => row.id === "x-ai")?.hint).toBe(
			"Unlocks Grok 4.7, Grok 4.6",
		);
	});

	it("saves each choice as a valid connection that maps back to it", () => {
		for (const choice of choices.map((row) => row.id)) {
			const raw = keyChoiceConnection(choice, {
				label: " ",
				apiKey: " test-only-key ",
				baseUrl: "https://llm.example.com/v1",
			});
			const input = modelConnectionInput.parse(raw);
			expect(input.apiKey).toBe("test-only-key");
			expect(input.label).toBe(keyChoiceLabel(choice));
			expect(connectionKeyChoice(input)).toBe(choice);
		}
		expect(
			keyChoiceConnection("x-ai", {
				label: "Work",
				apiKey: "test-only-key",
				baseUrl: "",
			}),
		).toEqual({
			provider: "compatible",
			label: "Work",
			apiKey: "test-only-key",
			baseUrl: "https://api.x.ai/v1",
		});
	});

	it("unlocks exactly the chosen maker's listed models", () => {
		for (const author of makers) {
			const input = modelConnectionInput.parse(
				keyChoiceConnection(author, {
					label: "",
					apiKey: "test-only-key",
					baseUrl: "",
				}),
			);
			// The key's own catalog lists every maker's direct id; only the
			// chosen maker's entries may be offered.
			const connection = {
				id: "55555555-5555-4555-8555-555555555555",
				provider: input.provider,
				label: input.label,
				baseUrl: input.baseUrl,
				revision: "r",
				models: API_MODEL_LIST.flatMap((entry) =>
					entry.directId
						? [
								{
									id: entry.directId,
									label: entry.label,
									toolStreamingVerified: false,
								},
							]
						: [],
				),
			} as PublicModelConnection;
			const expected = API_MODEL_LIST.filter(
				(entry) => entry.author === author && entry.directId,
			).map((entry) => entry.label);
			expect(connectionModels(connection, []).map((row) => row.label)).toEqual(
				expected,
			);
			expect(availableConnectionModels([connection], [])).toHaveLength(
				expected.length,
			);
			expect(
				providerConnections(author, [connection]).map((row) => row.id),
			).toEqual([connection.id]);
		}
	});

	it("does not offer a direct key for makers without listed direct ids", () => {
		for (const author of ["meta", "deepseek", "z-ai", "moonshotai", "qwen"])
			expect(makers).not.toContain(author);
	});
});

describe("SuperGrok subscription", () => {
	const key = {
		id: "55555555-5555-4555-8555-555555555555",
		provider: "compatible",
		label: "xAI",
		baseUrl: "https://api.x.ai/v1",
		revision: "r",
		models: [
			{ id: "grok-4.7", label: "Grok 4.7", toolStreamingVerified: false },
		],
	} as PublicModelConnection;
	const plan = {
		...key,
		id: "66666666-6666-4666-8666-666666666666",
		label: "SuperGrok",
		subscription: { provider: "xai", status: "ready" },
	} as PublicModelConnection;

	it("serves the xAI section first, its models labelled as on the subscription", () => {
		expect(
			providerConnections("x-ai", [key, plan]).map((row) => row.id),
		).toEqual([plan.id, key.id]);
		expect(
			availableConnectionModels([plan], []).map((model) => model.label),
		).toEqual(["Grok 4.7 · SuperGrok"]);
	});
});
