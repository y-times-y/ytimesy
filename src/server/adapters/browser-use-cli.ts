import { createHash } from "node:crypto";
import { posixShellCommand, posixShellQuoted } from "#/domain/posix-command";
import { DESKTOP_X_ENVIRONMENT } from "./freestyle/start-desktop";

export const PINNED_BROWSER_USE_VERSION = "0.13.11";
const uvVersion = "0.12.24";

/** Browser Use executes only in the untrusted execution VM, never the credential-bearing model worker. */
export function browserUseCommand(sessionId: string, code: string) {
	return `${browserUseSetup(sessionId)}
printf '%s' ${posixShellQuoted(code)} | ${posixShellCommand(["browser-use"])}`;
}

/** Installs the pinned CLI once and exports its environment; the caller pipes code into `browser-use`. */
export function browserUseSetup(sessionId: string) {
	const identity = createHash("sha256")
		.update(sessionId)
		.digest("hex")
		.slice(0, 24);
	return `set -eu
${DESKTOP_X_ENVIRONMENT}
export BH_HOME=/tmp/yb-${identity}
export BU_CDP_URL=http://127.0.0.1:9222
export BH_TELEMETRY=0 ANONYMIZED_TELEMETRY=false BH_RECORD=0 BH_TAB_MARKER=0 BU_AUTOSPAWN=0
export UV_TOOL_DIR="$HOME/.ytimesy-cli/browser-use-tools" UV_TOOL_BIN_DIR="$HOME/.ytimesy-cli/browser-use-bin"
mkdir -p "$HOME/.ytimesy-cli" "$UV_TOOL_BIN_DIR"
export PATH="$UV_TOOL_BIN_DIR:$HOME/.ytimesy-cli/uv:$HOME/.local/bin:$PATH"
(
  flock -w 180 9
  if ! command -v uv >/dev/null 2>&1; then
    curl -fsSL https://astral.sh/uv/${uvVersion}/install.sh | env UV_INSTALL_DIR="$HOME/.ytimesy-cli/uv" UV_NO_MODIFY_PATH=1 sh
  fi
  if ! "$UV_TOOL_DIR/browser-use/bin/python" -c "import importlib.metadata; assert importlib.metadata.version('browser-use') == '${PINNED_BROWSER_USE_VERSION}'" 2>/dev/null; then
    uv tool install --python 3.12 --upgrade --force browser-use==${PINNED_BROWSER_USE_VERSION}
  fi
) 9>"$HOME/.ytimesy-cli/browser-use.install.lock"`;
}
