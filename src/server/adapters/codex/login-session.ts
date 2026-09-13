import { readFileSync } from "node:fs";
import { Duration, Effect } from "effect";
import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { type CodexLoginStatus, parseCodexLoginStatus } from "./login-status";

const LOGIN_DAEMON_SOURCE = readFileSync(
	new URL("./login-daemon.py", import.meta.url),
	"utf8",
);

const CODEX_INSTALL_SCRIPT = `set -eu
export HOME="\${HOME:-/root}"
curl -fsSL https://chatgpt.com/codex/install.sh | sh
export PATH="$HOME/.local/bin:$HOME/.codex/bin:$HOME/.codex/packages/standalone/current:$PATH"
if [ -x "$HOME/.codex/packages/standalone/current/codex" ]; then
  CODEX_BIN="$HOME/.codex/packages/standalone/current/codex"
elif command -v codex >/dev/null 2>&1; then
  CODEX_BIN="$(command -v codex)"
else
  echo "codex binary not found after install" >&2
  exit 1
fi
echo "CODEX_BIN=$CODEX_BIN"
"$CODEX_BIN" --version
`;

const START_LOGIN_SCRIPT = `set -eu
if [ -f /tmp/ytimesy-codex-login.pid ] && kill -0 "$(cat /tmp/ytimesy-codex-login.pid)" 2>/dev/null; then
  echo "LOGIN_PID=$(cat /tmp/ytimesy-codex-login.pid)"
  exit 0
fi
rm -f /tmp/ytimesy-auth-status.json
PYTHONUNBUFFERED=1 setsid python3 /tmp/ytimesy-codex-login.py >/tmp/ytimesy-codex-login.log 2>&1 < /dev/null &
echo $! > /tmp/ytimesy-codex-login.pid
echo "LOGIN_PID=$(cat /tmp/ytimesy-codex-login.pid)"
`;

function firstMatch(stdout: string, pattern: RegExp): string | null {
	return stdout.match(pattern)?.[1]?.trim() ?? null;
}

function failedStatus(message: string): CodexLoginStatus {
	return { stage: "failed", message };
}

export function startInteractiveDeviceCodeLogin(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<CodexLoginStatus> {
	return Effect.gen(function* () {
		const install = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, CODEX_INSTALL_SCRIPT, 240_000),
		);
		if (install.exitCode !== 0) {
			return failedStatus(
				`Codex install failed: ${(install.stderr || install.stdout).trim()}`,
			);
		}

		const codexBin = firstMatch(install.stdout, /^CODEX_BIN=(.+)$/m);
		const codexVersion =
			firstMatch(install.stdout, /codex-cli\s+(\S+)/i) ?? null;
		if (!codexBin) {
			return failedStatus(
				"Codex install succeeded without reporting a binary path",
			);
		}

		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-codex-login.py",
				LOGIN_DAEMON_SOURCE,
			),
		);

		const start = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`export CODEX_BIN=${shellSingleQuote(codexBin)}
export CODEX_VERSION=${shellSingleQuote(codexVersion ?? "")}
${START_LOGIN_SCRIPT}`,
				30_000,
			),
		);
		if (start.exitCode !== 0) {
			return failedStatus(
				`Failed to start Codex login daemon: ${(start.stderr || start.stdout).trim()}`,
			);
		}

		for (let attempt = 0; attempt < 40; attempt += 1) {
			yield* Effect.sleep(Duration.seconds(1));
			const status = yield* readLoginStatus(machines, workspaceId);
			if (status.stage !== "missing" && status.stage !== "starting") {
				return status;
			}
		}

		const log = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, "/tmp/ytimesy-codex-login.log"),
		);
		return failedStatus(
			`Codex login did not publish a device code in time${log ? `: ${log.slice(-500)}` : ""}`,
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failedStatus(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

export function readLoginStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<CodexLoginStatus> {
	return Effect.tryPromise(() =>
		machines.readTextFile(workspaceId, "/tmp/ytimesy-auth-status.json"),
	).pipe(
		Effect.map(parseCodexLoginStatus),
		Effect.catchAll((cause) =>
			Effect.succeed(
				failedStatus(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
