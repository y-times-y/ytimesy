/**
 * The Codex CLI version our ChatGPT-subscription requests identify as (the
 * model catalog is versioned by it) and that native-Codex evaluations install.
 */
export const PINNED_CODEX_CLI_VERSION = "0.159.2";

export function pinnedCodexInstallCommand(): string {
	return `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`;
}

/**
 * The Claude Agent SDK that Claude Code chats run on the chat's VM. The SDK
 * starts the Claude Code build bundled with its release: 0.3.321 bundles
 * Claude Code 2.1.321, the first to know Fable 5.2 and Mythos 5.2 (0.3.296
 * verified with the edge proxy on 2026-11-01; 0.3.321 on 2026-11-09 against a
 * mock Anthropic API: the same single `POST /v1/messages` per request, no new
 * endpoint). Installed under /opt (root owned, readable by every user, so a
 * read-only helper running as the reader user can run it too); auto-updates
 * stay off so a turn never changes version under itself.
 */
export const PINNED_CLAUDE_AGENT_SDK_VERSION = "0.3.321";
export const CLAUDE_AGENT_SDK_PREFIX = `/opt/ytimesy-claude-agent-sdk/${PINNED_CLAUDE_AGENT_SDK_VERSION}`;
const SDK_PACKAGES = `${CLAUDE_AGENT_SDK_PREFIX}/node_modules/@anthropic-ai`;
/** The SDK's entry module, which the runner imports by path. */
export const CLAUDE_AGENT_SDK_MODULE = `${SDK_PACKAGES}/claude-agent-sdk/sdk.mjs`;
/** The Claude Code build the SDK starts on the VM's platform (linux-x64, glibc). */
export const CLAUDE_AGENT_SDK_CLAUDE_BINARY = `${SDK_PACKAGES}/claude-agent-sdk-linux-x64/claude`;

/**
 * Installs the pinned SDK unless it is there: as root in the tools image
 * (scripts/build-tools-snapshot.ts), through passwordless sudo on a VM
 * booted from an older image (the first Claude Code turn). Idempotent and
 * serialized, so parallel turns on one VM install it once.
 */
export function claudeAgentSdkInstallScript(asRoot: boolean): string {
	const sudo = asRoot ? "" : "sudo -n ";
	return `set -eu
if [ ! -f ${CLAUDE_AGENT_SDK_MODULE} ] || [ ! -x ${CLAUDE_AGENT_SDK_CLAUDE_BINARY} ]; then
  ${sudo}mkdir -p /opt/ytimesy-claude-agent-sdk
  (
    # The detached caller bounds installation; do not fail a second chat
    # merely because the first download takes more than five minutes.
    flock 9
    if [ ! -f ${CLAUDE_AGENT_SDK_MODULE} ] || [ ! -x ${CLAUDE_AGENT_SDK_CLAUDE_BINARY} ]; then
      ${sudo}rm -rf ${CLAUDE_AGENT_SDK_PREFIX}.tmp
      ${sudo}mkdir -p ${CLAUDE_AGENT_SDK_PREFIX}.tmp
      ${sudo}env npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm install --loglevel=error --prefer-offline --no-save --prefix ${CLAUDE_AGENT_SDK_PREFIX}.tmp @anthropic-ai/claude-agent-sdk@${PINNED_CLAUDE_AGENT_SDK_VERSION} >/dev/null
      # The read-only helper runs it as another user: readable and runnable by all.
      ${sudo}chmod -R a+rX ${CLAUDE_AGENT_SDK_PREFIX}.tmp
      ${sudo}rm -rf ${CLAUDE_AGENT_SDK_PREFIX}
      ${sudo}mv ${CLAUDE_AGENT_SDK_PREFIX}.tmp ${CLAUDE_AGENT_SDK_PREFIX}
    fi
  ) 9>/tmp/ytimesy-claude-agent-sdk-install.lock
fi
${CLAUDE_AGENT_SDK_CLAUDE_BINARY} --version >/dev/null`;
}
