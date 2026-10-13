/**
 * The Codex CLI version our ChatGPT-subscription requests identify as (the
 * model catalog is versioned by it) and that native-Codex evaluations install.
 */
export const PINNED_CODEX_CLI_VERSION = "0.159.2";

export function pinnedCodexInstallCommand(): string {
	return `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`;
}
