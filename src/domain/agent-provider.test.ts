import { describe, expect, it } from "vitest";
import { connectedAgentStatus } from "./agent-connection";
import {
	agentProviderById,
	CLAUDE_PROVIDER,
	CODEX_PROVIDER,
	DEFAULT_COMPOSER_HARNESS_ID,
	OPENCODE_PROVIDER,
	offeredAgentProviderId,
	offeredAgentProviders,
	recognizedAgentProviders,
} from "./agent-provider";

describe("agent providers", () => {
	it("offers Codex and Claude while preserving legacy provider records", () => {
		expect(offeredAgentProviders()).toEqual([CODEX_PROVIDER, CLAUDE_PROVIDER]);
		expect(recognizedAgentProviders()).toEqual([
			CODEX_PROVIDER,
			CLAUDE_PROVIDER,
			OPENCODE_PROVIDER,
		]);
		expect(agentProviderById("codex")).toEqual(CODEX_PROVIDER);
		expect(agentProviderById("claude")).toEqual(CLAUDE_PROVIDER);
		expect(agentProviderById("opencode")).toEqual(OPENCODE_PROVIDER);
		expect(OPENCODE_PROVIDER.signInMethod).toBeNull();
		expect(DEFAULT_COMPOSER_HARNESS_ID).toBe("codex");
		expect(offeredAgentProviderId("claude")).toBe("claude");
		expect(offeredAgentProviderId("opencode")).toBe("codex");
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
