import { expect, it } from "vitest";
import {
	PINNED_CODEX_CLI_VERSION,
	pinnedCodexInstallCommand,
} from "./guest-cli-pin";

it("installs exactly the pinned Codex CLI release", () => {
	expect(pinnedCodexInstallCommand()).toBe(
		`curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`,
	);
});
