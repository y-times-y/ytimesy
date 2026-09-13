import { describe, expect, it } from "vitest";
import { connectedAgentStatus } from "./agent-connection";
import { agentProviderById, offeredAgentProviders } from "./agent-provider";

describe("agent providers", () => {
	it("offers Codex first and does not invent other agents", () => {
		expect(offeredAgentProviders().map((provider) => provider.id)).toEqual([
			"codex",
		]);
		expect(agentProviderById("codex")).toEqual({
			id: "codex",
			name: "Codex",
			signInMethod: "ChatGPT",
			authorizeWith: "OpenAI",
		});
	});

	it("names the connected agent from its provider", () => {
		expect(connectedAgentStatus({ status: "disconnected" })).toBeNull();
		expect(
			connectedAgentStatus({
				status: "authenticated",
				provider: "codex",
				authMode: "chatgpt",
				planType: "prolite",
				email: null,
			}),
		).toBe("Codex · prolite");
	});
});
