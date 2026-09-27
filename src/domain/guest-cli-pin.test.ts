import { describe, expect, it } from "vitest";
import {
	ensurePinnedClaudeCommand,
	ensurePinnedCodexCommand,
	GUEST_CLI_PIN_ENV_PATH,
	guestCliDisableUpdateExports,
	guestCliPinSealScript,
	PINNED_CLAUDE_CLI_VERSION,
	PINNED_CODEX_CLI_VERSION,
	PINNED_OPENCODE_CLI_VERSION,
	pinnedClaudeInstallCommand,
	pinnedCodexInstallCommand,
	pinnedOpenCodeInstallCommand,
} from "./guest-cli-pin";

describe("guest CLI pin", () => {
	it("upgrades older snapshot binaries rather than only checking their presence", () => {
		expect(ensurePinnedCodexCommand()).toContain(
			`!= "codex-cli ${PINNED_CODEX_CLI_VERSION}"`,
		);
		expect(ensurePinnedClaudeCommand()).toContain(
			`!= "${PINNED_CLAUDE_CLI_VERSION} (Claude Code)"`,
		);
		expect(pinnedClaudeInstallCommand()).toContain("npm install --prefix");
	});
	it("pins installers to the versions the adapters parse", () => {
		expect(pinnedClaudeInstallCommand()).toContain(PINNED_CLAUDE_CLI_VERSION);
		expect(pinnedClaudeInstallCommand()).toContain(
			"@anthropic-ai/claude-code@",
		);
		expect(pinnedOpenCodeInstallCommand()).toContain(
			`--version ${PINNED_OPENCODE_CLI_VERSION}`,
		);
		expect(pinnedCodexInstallCommand()).toContain(
			`--release ${PINNED_CODEX_CLI_VERSION}`,
		);
		expect(pinnedClaudeInstallCommand()).not.toMatch(/\| bash$/);
		expect(pinnedOpenCodeInstallCommand()).not.toMatch(/\| bash$/);
		expect(pinnedCodexInstallCommand()).not.toMatch(/\| sh$/);
	});

	it("seals disable-update settings without downloading a newer CLI", () => {
		const exports = guestCliDisableUpdateExports();
		expect(exports).toContain("DISABLE_AUTOUPDATER='1'");
		expect(exports).toContain("DISABLE_UPDATES='1'");
		expect(exports).toContain("OPENCODE_DISABLE_AUTOUPDATE='true'");
		const seal = guestCliPinSealScript();
		expect(seal).toContain(GUEST_CLI_PIN_ENV_PATH);
		expect(seal).toContain(exports);
		expect(seal).toContain("autoupdate");
		expect(seal).toContain("showThinkingSummaries");
		expect(seal).toContain("check_for_update_on_startup");
		expect(seal).not.toContain("curl ");
		expect(seal).not.toContain("claude update");
		expect(seal).not.toContain("opencode upgrade");
	});
});
