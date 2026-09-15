import { readFileSync } from "node:fs";
import { Duration, Effect } from "effect";
import {
	claudeCliIsSignedIn,
	parseAnthropicLoginUrl,
	parseClaudeListedModels,
} from "#/domain/claude-auth";
import { SessionItemId, type WorkspaceId } from "#/domain/ids";
import type { ListedModel } from "#/domain/listed-model";
import { posixShellQuoted } from "#/domain/posix-command";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const LOGIN_DAEMON_SOURCE = readFileSync(
	new URL("./login-daemon.py", import.meta.url),
	"utf8",
);

const STATUS_PATH = "/tmp/ytimesy-claude-auth-status.json";
const LOG_PATH = "/tmp/ytimesy-claude-login.log";
const PID_PATH = "/tmp/ytimesy-claude-login.pid";
const KEY_ENV_PATH = "/tmp/ytimesy-claude-key.env";

const CLAUDE_INSTALL_SCRIPT = `set -eu
export HOME="\${HOME:-/root}"
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
else
  echo "claude binary not found after install" >&2
  exit 1
fi
echo "CLAUDE_BIN=$CLAUDE_BIN"
"$CLAUDE_BIN" --version
`;

const LOCATE_CLAUDE = `set -eu
if [ -z "\${HOME:-}" ]; then
  export HOME=/root
fi
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "claude binary not found" >&2
  exit 1
fi
echo "CLAUDE_HOME=$HOME"
echo "CLAUDE_BIN=$(command -v claude)"
claude --version
`;

const START_LOGIN_SCRIPT = `set -eu
if [ "\${FORCE_RESTART:-0}" = "1" ] && [ -f ${PID_PATH} ]; then
  PID="$(cat ${PID_PATH})"
  pkill -P "$PID" 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  rm -f ${PID_PATH}
fi
if [ -f ${PID_PATH} ] && kill -0 "$(cat ${PID_PATH})" 2>/dev/null; then
  echo "LOGIN_PID=$(cat ${PID_PATH})"
  exit 0
fi
rm -f ${STATUS_PATH}
PYTHONUNBUFFERED=1 setsid python3 /tmp/ytimesy-claude-login.py >${LOG_PATH} 2>&1 < /dev/null &
echo $! > ${PID_PATH}
echo "LOGIN_PID=$(cat ${PID_PATH})"
`;

export type ClaudeAuthStatus =
	| { readonly stage: "missing" }
	| { readonly stage: "starting" }
	| {
			readonly stage: "awaiting_device_code";
			readonly loginId: string;
			readonly verificationUrl: string;
	  }
	| {
			readonly stage: "authenticated";
			readonly authMode: "subscription" | "apikey";
			readonly planType: string | null;
			readonly models: readonly ListedModel[];
			readonly turnStatus: SessionTurnStatus;
			readonly items: readonly SessionItem[];
	  }
	| { readonly stage: "failed"; readonly message: string };

export function parseClaudeAuthStatus(
	contents: string | null,
): ClaudeAuthStatus {
	if (!contents) return { stage: "missing" };
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!isRecord(parsed)) {
			return { stage: "failed", message: "Claude status was not an object" };
		}
		const stage = readString(parsed.stage);
		if (stage === "starting") return { stage: "starting" };
		if (stage === "awaiting_device_code") {
			const verificationUrl = readString(parsed.verificationUrl);
			if (!verificationUrl) {
				return {
					stage: "failed",
					message: "Claude login did not publish Anthropic's URL",
				};
			}
			return {
				stage: "awaiting_device_code",
				loginId: readString(parsed.loginId) ?? "claude-auth",
				verificationUrl,
			};
		}
		if (stage === "authenticated") {
			return {
				stage: "authenticated",
				authMode: parsed.authMode === "apikey" ? "apikey" : "subscription",
				planType: readString(parsed.planType) ?? null,
				models: listedModels(parsed.models),
				turnStatus:
					parsed.turnStatus === "running" ||
					parsed.turnStatus === "completed" ||
					parsed.turnStatus === "failed"
						? parsed.turnStatus
						: "idle",
				items: simpleSessionItems(parsed.items),
			};
		}
		if (stage === "failed") {
			return {
				stage: "failed",
				message: readString(parsed.message) ?? "Claude Code login failed",
			};
		}
		return {
			stage: "failed",
			message: `Unknown Claude login stage: ${stage ?? "absent"}`,
		};
	} catch (cause) {
		return {
			stage: "failed",
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

export function readClaudeAuthStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.tryPromise(() =>
		machines.readTextFile(workspaceId, STATUS_PATH),
	).pipe(
		Effect.map(parseClaudeAuthStatus),
		Effect.catchAll(() => Effect.succeed({ stage: "missing" as const })),
	);
}

/**
 * Installs unmodified Claude Code and either resumes a CLI login, applies a
 * stored API key only after `claude auth status` accepts it, or starts
 * Anthropic's own authorize URL.
 */
export function connectClaudeCode(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	apiKey: string | null,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const install = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, CLAUDE_INSTALL_SCRIPT, 240_000),
		);
		if (install.exitCode !== 0) {
			return failed(
				`Claude Code install failed: ${(install.stderr || install.stdout).trim()}`,
			);
		}
		const claudeBin = firstMatch(install.stdout, /^CLAUDE_BIN=(.+)$/m);
		if (!claudeBin) {
			return failed("Claude Code install succeeded without reporting a binary");
		}

		const existing = yield* probeClaudeCli(
			machines,
			workspaceId,
			claudeBin,
			null,
		);
		if (existing.stage === "authenticated") return existing;

		if (apiKey) {
			const byok = yield* applyStoredClaudeKey(
				machines,
				workspaceId,
				claudeBin,
				apiKey,
			);
			if (byok.stage === "authenticated") return byok;
			if (byok.stage === "failed") return byok;
		}

		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-claude-login.py",
				LOGIN_DAEMON_SOURCE,
			),
		);
		const start = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`export CLAUDE_BIN=${posixShellQuoted(claudeBin)}
${START_LOGIN_SCRIPT}`,
				30_000,
			),
		);
		if (start.exitCode !== 0) {
			return failed(
				`Failed to start Claude Code login: ${(start.stderr || start.stdout).trim()}`,
			);
		}
		for (let attempt = 0; attempt < 40; attempt += 1) {
			yield* Effect.sleep(Duration.seconds(1));
			const status = yield* readClaudeAuthStatus(machines, workspaceId);
			if (status.stage !== "missing" && status.stage !== "starting") {
				if (status.stage === "authenticated" && status.models.length === 0) {
					return yield* attachClaudeModels(
						machines,
						workspaceId,
						claudeBin,
						status,
					);
				}
				return status;
			}
		}
		const log = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, LOG_PATH),
		);
		const url = parseAnthropicLoginUrl(log ?? "");
		if (url) {
			return {
				stage: "awaiting_device_code" as const,
				loginId: "claude-auth",
				verificationUrl: url,
			};
		}
		return failed(
			`Claude Code did not publish Anthropic's login URL${log ? `: ${log.slice(-500)}` : ""}`,
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failed(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

export function refreshClaudeAuthStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const published = yield* readClaudeAuthStatus(machines, workspaceId);
		if (published.stage === "authenticated") return published;
		const locate = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, LOCATE_CLAUDE, 30_000),
		);
		if (locate.exitCode !== 0) {
			return published.stage === "missing" ? published : published;
		}
		const claudeBin = firstMatch(locate.stdout, /^CLAUDE_BIN=(.+)$/m);
		if (!claudeBin) return published;
		const live = yield* probeClaudeCli(machines, workspaceId, claudeBin, null);
		if (live.stage === "authenticated") return live;
		if (published.stage === "awaiting_device_code") return published;
		return live.stage === "failed" ? published : live;
	}).pipe(Effect.catchAll(() => readClaudeAuthStatus(machines, workspaceId)));
}

function applyStoredClaudeKey(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	apiKey: string,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				KEY_ENV_PATH,
				`export ANTHROPIC_API_KEY=${posixShellQuoted(apiKey)}\n`,
			),
		);
		const probed = yield* probeClaudeCli(
			machines,
			workspaceId,
			claudeBin,
			KEY_ENV_PATH,
		);
		if (probed.stage !== "authenticated") {
			return failed(
				"Claude Code did not accept the stored API key. Sign in on Anthropic's page instead.",
			);
		}
		return probed;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failed(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

function probeClaudeCli(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	keyEnvPath: string | null,
): Effect.Effect<ClaudeAuthStatus> {
	const prefix = keyEnvPath ? `. ${posixShellQuoted(keyEnvPath)}\n` : "";
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`${prefix}${posixShellQuoted(claudeBin)} auth status`,
			30_000,
		),
	).pipe(
		Effect.flatMap((result) =>
			Effect.gen(function* () {
				const output = `${result.stdout}\n${result.stderr}`;
				if (!claudeCliIsSignedIn(output)) {
					return { stage: "missing" as const };
				}
				const models = yield* listClaudeModels(
					machines,
					workspaceId,
					claudeBin,
					keyEnvPath,
				);
				return {
					stage: "authenticated" as const,
					authMode: keyEnvPath
						? ("apikey" as const)
						: ("subscription" as const),
					planType: null,
					models,
					turnStatus: "idle" as const,
					items: [],
				};
			}),
		),
		Effect.catchAll(() => Effect.succeed({ stage: "missing" as const })),
	);
}

function attachClaudeModels(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	status: Extract<ClaudeAuthStatus, { stage: "authenticated" }>,
): Effect.Effect<ClaudeAuthStatus> {
	return listClaudeModels(machines, workspaceId, claudeBin, null).pipe(
		Effect.map((models) => ({ ...status, models })),
	);
}

function listClaudeModels(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	keyEnvPath: string | null,
): Effect.Effect<readonly ListedModel[]> {
	const prefix = keyEnvPath ? `. ${posixShellQuoted(keyEnvPath)}\n` : "";
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`${prefix}${posixShellQuoted(claudeBin)} models --json || ${posixShellQuoted(claudeBin)} models || true`,
			30_000,
		),
	).pipe(
		Effect.map((result) =>
			parseClaudeListedModels(`${result.stdout}\n${result.stderr}`),
		),
		Effect.catchAll(() => Effect.succeed([] as const)),
	);
}

function failed(message: string): ClaudeAuthStatus {
	return { stage: "failed", message };
}

function firstMatch(stdout: string, pattern: RegExp): string | null {
	return stdout.match(pattern)?.[1]?.trim() ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function simpleSessionItems(value: unknown): readonly SessionItem[] {
	if (!Array.isArray(value)) return [];
	const items: SessionItem[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const id = readString(row.id);
		const kind = readString(row.kind);
		if (!id || !kind) continue;
		if (kind === "userMessage" && readString(row.text)) {
			items.push({
				kind: "userMessage",
				id: SessionItemId(id),
				text: String(row.text),
			});
		}
		if (kind === "agentMessage" && readString(row.text)) {
			items.push({
				kind: "agentMessage",
				id: SessionItemId(id),
				text: String(row.text),
			});
		}
		if (kind === "error" && readString(row.message)) {
			items.push({
				kind: "error",
				id: SessionItemId(id),
				message: String(row.message),
			});
		}
	}
	return items;
}

function listedModels(value: unknown): readonly ListedModel[] {
	if (!Array.isArray(value)) return [];
	const models: ListedModel[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const id = readString(row.id);
		if (!id) continue;
		const label = readString(row.label) ?? id;
		const notice = readString(row.notice);
		models.push(notice ? { id, label, notice } : { id, label });
	}
	return models;
}

export function submitClaudeTask(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly promptText?: string;
	},
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const current = yield* refreshClaudeAuthStatus(machines, workspaceId);
		if (current.stage !== "authenticated") return current;
		const locate = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, LOCATE_CLAUDE, 30_000),
		);
		const claudeBin = firstMatch(locate.stdout, /^CLAUDE_BIN=(.+)$/m);
		if (locate.exitCode !== 0 || !claudeBin) {
			return failed("Claude Code is not installed on this workspace");
		}
		const userItem: SessionItem = {
			kind: "userMessage",
			id: SessionItemId(`claude-user-${Date.now()}`),
			text: input.text,
		};
		const running: ClaudeAuthStatus = {
			...current,
			turnStatus: "running",
			items: [...current.items, userItem],
		};
		yield* persistClaudeStatus(machines, workspaceId, running);
		const keyPrefix = `if [ -f ${KEY_ENV_PATH} ]; then . ${KEY_ENV_PATH}; fi\n`;
		const result = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`${keyPrefix}${posixShellQuoted(claudeBin)} -p --output-format text --dangerously-skip-permissions --model ${posixShellQuoted(input.modelId)} ${posixShellQuoted(input.promptText ?? input.text)}`,
				180_000,
			),
		);
		const output = (result.stdout || result.stderr).trim();
		const next: ClaudeAuthStatus =
			result.exitCode === 0 && output
				? {
						...current,
						turnStatus: "completed",
						items: [
							...running.items,
							{
								kind: "agentMessage",
								id: SessionItemId(`claude-agent-${Date.now()}`),
								text: output,
							},
						],
					}
				: {
						...current,
						turnStatus: "failed",
						items: [
							...running.items,
							{
								kind: "error",
								id: SessionItemId(`claude-error-${Date.now()}`),
								message: output || "Claude Code did not return a response.",
							},
						],
					};
		yield* persistClaudeStatus(machines, workspaceId, next);
		return next;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failed(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

function persistClaudeStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	status: ClaudeAuthStatus,
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.writeTextFile(
			workspaceId,
			STATUS_PATH,
			`${JSON.stringify(status)}\n`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}
