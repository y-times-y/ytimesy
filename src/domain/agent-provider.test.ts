import { describe, expect, it } from "vitest";
import { connectedAgentStatus } from "./agent-connection";
import {
	agentProviderById,
	CLAUDE_PROVIDER,
	CODEX_PROVIDER,
	OPENCODE_PROVIDER,
	offeredAgentProviders,
} from "./agent-provider";

describe("agent providers", () => {
	it("offers Codex, Claude, and OpenCode and does not invent other agents", () => {
		expect(offeredAgentProviders()).toEqual([
			CODEX_PROVIDER,
			CLAUDE_PROVIDER,
			OPENCODE_PROVIDER,
		]);
		expect(agentProviderById("codex")).toEqual(CODEX_PROVIDER);
		expect(agentProviderById("claude")).toEqual(CLAUDE_PROVIDER);
		expect(agentProviderById("opencode")).toEqual(OPENCODE_PROVIDER);
	});

	it("names the connected agent from its provider", () => {
		expect(connectedAgentStatus({ status: "disconnected" })).toBeNull();
		expect(
			connectedAgentStatus({
				status: "authenticated",
				provider: "codex",
				authMode: "apikey",
				planType: null,
				email: null,
			}),
		).toBe("Codex · API key");
		expect(
			connectedAgentStatus({
				status: "authenticated",
				provider: "claude",
				authMode: "subscription",
				planType: null,
				email: null,
			}),
		).toBe("Claude Code");
		expect(
			connectedAgentStatus({
				status: "authenticated",
				provider: "opencode",
				authMode: "local",
				planType: null,
				email: null,
			}),
		).toBe("OpenCode");
	});
});
