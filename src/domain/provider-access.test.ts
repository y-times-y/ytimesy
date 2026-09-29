import { describe, expect, it } from "vitest";
import type { PublicModelConnection } from "./model-connection";
import {
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
		expect(providerKeyConnection("meta", "test-only")).toEqual({
			provider: "compatible",
			label: "Meta",
			apiKey: "test-only",
			baseUrl: "https://api.meta.ai/v1",
		});
		expect(providerKeyConnection("google", "test-only").provider).toBe(
			"google",
		);
		expect(providerKeyConnection("deepseek", "test-only").baseUrl).toBe(
			"https://api.deepseek.com",
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
