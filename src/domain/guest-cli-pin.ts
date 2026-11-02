/**
 * The Codex CLI version our ChatGPT-subscription requests identify as (the
 * model catalog is versioned by it) and that native-Codex evaluations install.
 */
export const PINNED_CODEX_CLI_VERSION = "0.159.2";

export function pinnedCodexInstallCommand(): string {
	return `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`;
}

/**
 * The Claude Code CLI that Claude Code chats run, unmodified, on the chat's
 * VM. Verified with the edge proxy on 2026-11-01. Installed under /opt (root
 * owned, readable by every user, so a read-only helper running as the
 * reader user can run it too); auto-updates stay off so a turn never
 * changes version under itself.
 */
export const PINNED_CLAUDE_CODE_VERSION = "2.1.296";
export const CLAUDE_CODE_PREFIX = `/opt/ytimesy-claude-code/${PINNED_CLAUDE_CODE_VERSION}`;
export const CLAUDE_CODE_BINARY = `${CLAUDE_CODE_PREFIX}/bin/claude`;

/**
 * Installs the pinned CLI unless it is there: as root in the tools image
 * (scripts/build-tools-snapshot.ts), through passwordless sudo on a VM
 * booted from an older image (the first Claude Code turn). Idempotent and
 * serialized, so parallel turns on one VM install it once.
 */
export function claudeCodeInstallScript(asRoot: boolean): string {
	const sudo = asRoot ? "" : "sudo -n ";
	return `set -eu
if [ ! -x ${CLAUDE_CODE_BINARY} ]; then
  ${sudo}mkdir -p /opt/ytimesy-claude-code
  (
    flock -w 300 9
    if [ ! -x ${CLAUDE_CODE_BINARY} ]; then
      ${sudo}rm -rf ${CLAUDE_CODE_PREFIX}.tmp
      ${sudo}env npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm install -g --silent --prefix ${CLAUDE_CODE_PREFIX}.tmp @anthropic-ai/claude-code@${PINNED_CLAUDE_CODE_VERSION} >/dev/null
      ${sudo}rm -rf ${CLAUDE_CODE_PREFIX}
      ${sudo}mv ${CLAUDE_CODE_PREFIX}.tmp ${CLAUDE_CODE_PREFIX}
    fi
  ) 9>/tmp/ytimesy-claude-code-install.lock
fi
${CLAUDE_CODE_BINARY} --version >/dev/null`;
}
