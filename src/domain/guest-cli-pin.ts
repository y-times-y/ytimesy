import { posixShellQuoted } from "./posix-command";

/**
 * Guest CLIs the adapters already parse. Freestyle snapshots do not
 * upgrade these binaries; the CLIs themselves will unless updates are
 * disabled. A newer guest binary is unsupported until the adapter is.
 */
export const PINNED_CLAUDE_CLI_VERSION = "2.1.234";
export const PINNED_OPENCODE_CLI_VERSION = "1.18.18";
export const PINNED_CODEX_CLI_VERSION = "0.154.0";

export const GUEST_CLI_PIN_ENV_PATH = "/tmp/ytimesy-guest-cli-pin.env";

export function guestCliDisableUpdateEnv(): Readonly<Record<string, string>> {
	return {
		DISABLE_AUTOUPDATER: "1",
		DISABLE_UPDATES: "1",
		OPENCODE_DISABLE_AUTOUPDATE: "true",
	};
}

export function guestCliDisableUpdateExports(): string {
	return Object.entries(guestCliDisableUpdateEnv())
		.map(([key, value]) => `export ${key}=${posixShellQuoted(value)}`)
		.join("\n");
}

export function pinnedClaudeInstallCommand(): string {
	return `curl -fsSL https://claude.ai/install.sh | bash -s -- ${PINNED_CLAUDE_CLI_VERSION}`;
}

export function pinnedOpenCodeInstallCommand(): string {
	return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${PINNED_OPENCODE_CLI_VERSION}`;
}

export function pinnedCodexInstallCommand(): string {
	return `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${PINNED_CODEX_CLI_VERSION}`;
}

/**
 * Writes disable-update env and CLI settings on a guest. Does not
 * download or replace an already-installed binary.
 */
export function guestCliPinSealScript(): string {
	return `set -eu
${guestCliDisableUpdateExports()}
cat > ${GUEST_CLI_PIN_ENV_PATH} <<'EOF'
${guestCliDisableUpdateExports()}
EOF
python3 - <<'PY'
import json, os
from pathlib import Path

homes = []
for candidate in (os.environ.get("HOME"), "/home/ubuntu", "/root"):
    if candidate and candidate not in homes:
        homes.append(candidate)

def load_json(path: Path):
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text() or "{}")
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}

pin_env = ${JSON.stringify(GUEST_CLI_PIN_ENV_PATH)}
bashrc_marker = "ytimesy guest cli pin"
bashrc_block = "\\n# " + bashrc_marker + "\\nif [ -f " + pin_env + " ]; then . " + pin_env + "; fi\\n"

def pin_one_home(home_path: Path):
    claude = home_path / ".claude" / "settings.json"
    claude.parent.mkdir(parents=True, exist_ok=True)
    settings = load_json(claude)
    env = settings["env"] if isinstance(settings.get("env"), dict) else {}
    env["DISABLE_AUTOUPDATER"] = "1"
    env["DISABLE_UPDATES"] = "1"
    settings["env"] = env
    settings["showThinkingSummaries"] = True
    claude.write_text(json.dumps(settings, indent=2) + "\\n")

    opencode = home_path / ".config" / "opencode" / "opencode.json"
    opencode.parent.mkdir(parents=True, exist_ok=True)
    config = load_json(opencode)
    config["autoupdate"] = False
    opencode.write_text(json.dumps(config, indent=2) + "\\n")

    bashrc = home_path / ".bashrc"
    text = bashrc.read_text() if bashrc.is_file() else ""
    if bashrc_marker not in text:
        bashrc.write_text(text + bashrc_block)

    codex = home_path / ".codex" / "config.toml"
    codex.parent.mkdir(parents=True, exist_ok=True)
    current = codex.read_text() if codex.is_file() else ""
    if "check_for_update_on_startup" not in current:
        suffix = "\\n" if current and not current.endswith("\\n") else ""
        codex.write_text(current + suffix + "check_for_update_on_startup = false\\n")

for home in homes:
    home_path = Path(home)
    if not os.access(home_path, os.W_OK):
        continue
    try:
        pin_one_home(home_path)
    except OSError:
        continue
PY
`;
}