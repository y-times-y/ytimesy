import { describe, expect, it } from "vitest";
import { connectedAgentStatus } from "./agent-connection";
import {
	agentProviderById,
	CLAUDE_PROVIDER,
	CODEX_PROVIDER,
	offeredAgentProviders,
} from "./agent-provider";

describe("agent providers", () => {
	it("offers Codex and Claude and does not invent other agents", () => {
		expect(offeredAgentProviders()).toEqual([CODEX_PROVIDER, CLAUDE_PROVIDER]);
		expect(agentProviderById("codex")).toEqual(CODEX_PROVIDER);
		expect(agentProviderById("claude")).toEqual(CLAUDE_PROVIDER);
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
