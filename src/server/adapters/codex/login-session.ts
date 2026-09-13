import { readFileSync } from "node:fs";
import { Duration, Effect } from "effect";
import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import {
	type CodexLoginStatus,
	isChatgptCliLoginOutput,
	PREFERRED_CODEX_MODEL_ID,
	parseCodexLoginStatus,
} from "./login-status";

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
if [ "\${FORCE_RESTART:-0}" = "1" ] && [ -f /tmp/ytimesy-codex-login.pid ]; then
  kill "$(cat /tmp/ytimesy-codex-login.pid)" 2>/dev/null || true
  rm -f /tmp/ytimesy-codex-login.pid
fi
if [ -f /tmp/ytimesy-codex-login.pid ] && kill -0 "$(cat /tmp/ytimesy-codex-login.pid)" 2>/dev/null; then
  echo "LOGIN_PID=$(cat /tmp/ytimesy-codex-login.pid)"
  exit 0
fi
rm -f /tmp/ytimesy-auth-status.json
PYTHONUNBUFFERED=1 setsid python3 /tmp/ytimesy-codex-login.py >/tmp/ytimesy-codex-login.log 2>&1 < /dev/null &
echo $! > /tmp/ytimesy-codex-login.pid
echo "LOGIN_PID=$(cat /tmp/ytimesy-codex-login.pid)"
`;

const LOCATE_CODEX = `set -eu
if [ -z "\${HOME:-}" ]; then
  export HOME=/root
fi
CODEX_BIN=""
for home in "$HOME" /home/ubuntu /root; do
  if [ -x "$home/.codex/packages/standalone/current/codex" ]; then
    export HOME="$home"
    CODEX_BIN="$home/.codex/packages/standalone/current/codex"
    break
  fi
done
export PATH="$HOME/.local/bin:$HOME/.codex/bin:$HOME/.codex/packages/standalone/current:$PATH"
if [ -z "$CODEX_BIN" ] && command -v codex >/dev/null 2>&1; then
  CODEX_BIN="$(command -v codex)"
fi
if [ -z "$CODEX_BIN" ]; then
  echo "codex binary not found" >&2
  exit 1
fi
echo "CODEX_HOME=$HOME"
echo "CODEX_BIN=$CODEX_BIN"
"$CODEX_BIN" --version
`;

const CONFIRM_CHATGPT_LOGIN = `${LOCATE_CODEX}
if [ ! -f "$HOME/.codex/auth.json" ]; then
  echo "MISSING_AUTH_FILE" >&2
  exit 1
fi
echo "AUTH_FILE_PRESENT"
STATUS="$("$CODEX_BIN" login status 2>&1 || true)"
echo "$STATUS"
if echo "$STATUS" | grep -q "Logged in using ChatGPT"; then
  echo "CHATGPT_LOGIN_CONFIRMED"
  exit 0
fi
echo "NOT_CHATGPT_LOGIN" >&2
exit 1
`;

const STOP_LOGIN_DAEMON = `set -eu
if [ -f /tmp/ytimesy-codex-login.pid ]; then
  PID="$(cat /tmp/ytimesy-codex-login.pid)"
  pkill -P "$PID" 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  rm -f /tmp/ytimesy-codex-login.pid
fi
sync
echo "LOGIN_DAEMON_STOPPED"
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
	options: { skipInitialTurn?: boolean } = {},
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
export CODEX_PREFERRED_MODEL=${shellSingleQuote(PREFERRED_CODEX_MODEL_ID)}
export YTIMESY_SKIP_INITIAL_TURN=${options.skipInitialTurn ? "1" : "0"}
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

export function resumeCodexSession(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	options: { skipInitialTurn?: boolean } = {},
): Effect.Effect<CodexLoginStatus> {
	return Effect.gen(function* () {
		const locate = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`${LOCATE_CODEX}
"$CODEX_BIN" login status
`,
				30_000,
			),
		);
		if (locate.exitCode !== 0) {
			return failedStatus(
				`Cannot resume Codex session: ${(locate.stderr || locate.stdout).trim()}`,
			);
		}
		const codexBin = firstMatch(locate.stdout, /^CODEX_BIN=(.+)$/m);
		const codexVersion =
			firstMatch(locate.stdout, /codex-cli\s+(\S+)/i) ?? null;
		if (!codexBin) {
			return failedStatus("Cannot resume Codex session without a binary path");
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
export CODEX_PREFERRED_MODEL=${shellSingleQuote(PREFERRED_CODEX_MODEL_ID)}
export YTIMESY_SKIP_INITIAL_TURN=${options.skipInitialTurn ? "1" : "0"}
export FORCE_RESTART=1
${START_LOGIN_SCRIPT}`,
				30_000,
			),
		);
		if (start.exitCode !== 0) {
			return failedStatus(
				`Failed to resume Codex session: ${(start.stderr || start.stdout).trim()}`,
			);
		}

		for (let attempt = 0; attempt < 90; attempt += 1) {
			yield* Effect.sleep(Duration.seconds(2));
			const status = yield* readLoginStatus(machines, workspaceId);
			if (
				status.stage === "authenticated" ||
				status.stage === "failed" ||
				status.stage === "awaiting_device_code"
			) {
				return status;
			}
		}
		return failedStatus(
			"Resumed Codex session did not finish model/list or turn/start",
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failedStatus(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

/**
 * Stops the login daemon before a Freestyle snapshot so the capture is
 * Codex-on-disk (including ~/.codex/auth.json), not a live app-server with
 * stale sockets.
 */
export function stopCodexLoginDaemon(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<void, never, never> {
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, STOP_LOGIN_DAEMON, 30_000),
	).pipe(
		Effect.flatMap(() => Effect.void),
		Effect.catchAll(() => Effect.void),
	);
}

export function confirmChatgptLoginOnWorkspace(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<
	| { readonly confirmed: true }
	| { readonly confirmed: false; readonly message: string }
> {
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, CONFIRM_CHATGPT_LOGIN, 30_000),
	).pipe(
		Effect.map((result) => {
			const output = `${result.stdout}\n${result.stderr}`;
			if (isChatgptCliLoginOutput(output)) {
				return { confirmed: true as const };
			}
			return {
				confirmed: false as const,
				message: output.trim(),
			};
		}),
		Effect.catchAll((cause) =>
			Effect.succeed({
				confirmed: false as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}

export function snapshotAuthenticatedCodexWorkspace(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<
	| { readonly ok: true; readonly snapshotId: string; readonly public: false }
	| { readonly ok: false; readonly message: string }
> {
	return Effect.gen(function* () {
		const confirmed = yield* confirmChatgptLoginOnWorkspace(
			machines,
			workspaceId,
		);
		if (!confirmed.confirmed) {
			return {
				ok: false as const,
				message: `Refusing to snapshot without ChatGPT login: ${confirmed.message}`,
			};
		}
		yield* stopCodexLoginDaemon(machines, workspaceId);
		const snapshot = yield* Effect.tryPromise(() =>
			machines.snapshotAuthenticatedWorkspace(workspaceId),
		);
		return {
			ok: true as const,
			snapshotId: snapshot.snapshotId,
			public: snapshot.public,
		};
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				ok: false as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
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

export function submitCodexTask(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	input: { readonly text: string; readonly modelId: string },
): Effect.Effect<CodexLoginStatus> {
	const taskId = crypto.randomUUID();
	return Effect.gen(function* () {
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-task-request.json",
				`${JSON.stringify({
					id: taskId,
					text: input.text,
					modelId: input.modelId,
				})}\n`,
			),
		);
		for (let attempt = 0; attempt < 90; attempt += 1) {
			yield* Effect.sleep(Duration.seconds(2));
			const raw = yield* Effect.tryPromise(() =>
				machines.readTextFile(workspaceId, "/tmp/ytimesy-task-result.json"),
			);
			if (raw && resultMatchesTask(raw, taskId)) {
				return yield* readLoginStatus(machines, workspaceId);
			}
		}
		return failedStatus("Codex did not finish the task in time");
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failedStatus(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

function resultMatchesTask(raw: string, taskId: string): boolean {
	try {
		const parsed: unknown = JSON.parse(raw);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"id" in parsed &&
			parsed.id === taskId
		);
	} catch {
		return false;
	}
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
