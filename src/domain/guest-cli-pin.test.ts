import { expect, it } from "vitest";
import {
	claudeAgentSdkInstallScript,
	PINNED_CLAUDE_AGENT_SDK_VERSION,
	PINNED_CODEX_CLI_VERSION,
	pinnedCodexInstallCommand,
} from "./guest-cli-pin";

it("refreshes official npm metadata when an old tools image lacks the pinned SDK release", () => {
	for (const root of [true, false]) {
		const script = claudeAgentSdkInstallScript(root);
		expect(script).toContain(
			`@anthropic-ai/claude-agent-sdk@${PINNED_CLAUDE_AGENT_SDK_VERSION}`,
		);
		expect(script).toContain(
			"--prefer-online --registry=https://registry.npmjs.org",
		);
		expect(script).not.toContain("--prefer-offline");
	}
});

it("installs exactly the pinned Codex CLI release", () => {
	expect(pinnedCodexInstallCommand()).toBe(
		`curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`,
	);
});
