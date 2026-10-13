import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { AGENT_ORCHESTRATION_INSTRUCTIONS } from "#/domain/agent-orchestration";
import {
	claudeBackgroundTurnResult,
	claudeCliIsSignedIn,
	parseClaudeBinaryPath,
	parseClaudeCapabilitiesFromHelp,
	parseClaudeHomePath,
	parseClaudeModelFlagsFromHelp,
} from "#/domain/claude-auth";
import {
	claudeSettingsPath,
	claudeSettingsShowingThoughts,
} from "#/domain/claude-home";
import { claudeTurnItemsFromStream } from "#/domain/claude-stream";
import { failureMessage } from "#/domain/failure-message";
import {
	ensurePinnedClaudeCommand,
	guestCliDisableUpdateExports,
} from "#/domain/guest-cli-pin";
import { SessionItemId, type WorkspaceId } from "#/domain/ids";
import {
	type ListedModel,
	listedFastModeId,
	listedModelSupportsFastMode,
	listedReasoningFromRow,
} from "#/domain/listed-model";
import { posixShellQuoted } from "#/domain/posix-command";
import type {
	SessionItem,
	SessionTurnStatus,
	ToolActivityStatus,
} from "#/domain/session-item";
import type { ClaudeHomeRestore } from "#/server/adapters/claude/home-files";
import { REMOVE_CODEX_CREDENTIAL_FILES } from "#/server/adapters/codex/credential-files";
import { DEVELOPER_INSTRUCTIONS_PATH } from "#/server/adapters/freestyle/clone-project";
import { ensureGuestCliPin } from "#/server/adapters/guest-cli-pin";
import {
	PEER_INBOX_PATH,
	PEER_INBOX_SOURCE,
} from "#/server/services/peer-inbox";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { embedTaskToolDefinitions } from "../task-tool-source";

const TURN_PTY_SOURCE = readFileSync(
	new URL("./turn-pty.py", import.meta.url),
	"utf8",
);
const TASK_TOOL_SERVER_SOURCE = embedTaskToolDefinitions(
	readFileSync(new URL("./task-tool-server.py", import.meta.url), "utf8"),
);

const STATUS_PATH = "/tmp/ytimesy-claude-auth-status.json";
const PID_PATH = "/tmp/ytimesy-claude-login.pid";
const KEY_ENV_PATH = "/tmp/ytimesy-claude-key.env";
const TURN_OUT_PATH = "/tmp/ytimesy-claude-turn.out";
const TURN_ERR_PATH = "/tmp/ytimesy-claude-turn.err";
const TURN_EXIT_PATH = "/tmp/ytimesy-claude-turn.exit";
const TURN_PID_PATH = "/tmp/ytimesy-claude-turn.pid";
const TURN_PTY_PATH = "/tmp/ytimesy-claude-turn-pty.py";
const TASK_TOOL_SERVER_PATH = "/tmp/ytimesy-claude-task-tools.py";
const TASK_TOOL_CONFIG_PATH = "/tmp/ytimesy-claude-task-tools.json";
const TASK_TOOL_CONFIG = `${JSON.stringify({
	mcpServers: {
		ytimesy_tasks: {
			type: "stdio",
			command: "python3",
			args: [TASK_TOOL_SERVER_PATH],
		},
	},
})}\n`;

const CLAUDE_INSTALL_SCRIPT = `set -eu
${guestCliDisableUpdateExports()}
export HOME="\${HOME:-/root}"
export PATH="$HOME/.ytimesy-cli/node_modules/.bin:$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"
${ensurePinnedClaudeCommand()}
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
${guestCliDisableUpdateExports()}
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
 * Connects the unmodified CLI using the explicitly supplied API key.
 * Subscription credentials are not restored or used as a fallback.
 */
export function connectClaudeCode(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	apiKey: string | null,
	_restore?: ClaudeHomeRestore,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		if (!apiKey)
			return failed("Add your Anthropic API key in the model picker.");
		yield* ensureGuestCliPin(machines, workspaceId);
		const located = yield* locateOrInstallClaude(machines, workspaceId);
		if (!located)
			return failed("Claude Code is not installed on this workspace");
		yield* stopClaudeLoginDaemon(machines, workspaceId);
		return yield* applyStoredClaudeKey(
			machines,
			workspaceId,
			located.bin,
			apiKey,
		);
	}).pipe(
		Effect.catchAll(() =>
			Effect.succeed(failed("Could not connect with the Anthropic API key.")),
		),
	);
}

function locateOrInstallClaude(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<{ readonly bin: string; readonly home: string } | null> {
	return Effect.gen(function* () {
		const located = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, guestBash(LOCATE_CLAUDE), 15_000),
		);
		const home = parseClaudeHomePath(located.stdout) ?? "/root";
		const existing = parseClaudeBinaryPath(located.stdout);
		if (existing) return { bin: existing, home };
		const install = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, guestBash(CLAUDE_INSTALL_SCRIPT), 240_000),
		);
		if (install.exitCode !== 0) return null;
		const installed = parseClaudeBinaryPath(install.stdout);
		if (!installed) return null;
		return {
			bin: installed,
			home: parseClaudeHomePath(install.stdout) ?? home,
		};
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function guestBash(script: string) {
	return `bash -lc ${posixShellQuoted(`${guestCliDisableUpdateExports()}\n${script}`)}`;
}

function stopClaudeLoginDaemon(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			guestBash(
				`if [ -f ${PID_PATH} ]; then PID="$(cat ${PID_PATH})"; pkill -P "$PID" 2>/dev/null || true; kill "$PID" 2>/dev/null || true; rm -f ${PID_PATH}; fi`,
			),
			10_000,
		),
	).pipe(
		Effect.as(undefined),
		Effect.catchAll(() => Effect.void),
	);
}

export function refreshClaudeAuthStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const published = yield* readClaudeAuthStatus(machines, workspaceId);
		if (published.stage !== "authenticated" || published.authMode !== "apikey")
			return failed("Add your Anthropic API key in the model picker.");
		if (published.turnStatus === "running")
			return yield* syncClaudeBackgroundTurn(machines, workspaceId, published);
		return published;
	});
}

function applyStoredClaudeKey(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	apiKey: string,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const previous = yield* readClaudeAuthStatus(machines, workspaceId);
		if (
			previous.stage === "authenticated" &&
			previous.authMode === "apikey" &&
			previous.turnStatus === "running"
		) {
			return yield* syncClaudeBackgroundTurn(machines, workspaceId, previous);
		}
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
				"Claude Code did not accept the API key. Update it in the model picker.",
			);
		}
		const connected = {
			...probed,
			items: previous.stage === "authenticated" ? previous.items : probed.items,
			turnStatus:
				previous.stage === "authenticated"
					? previous.turnStatus
					: probed.turnStatus,
		};
		yield* persistClaudeStatus(machines, workspaceId, connected);
		return connected;
	}).pipe(
		Effect.catchAll(() =>
			Effect.succeed(failed("Could not apply the Anthropic API key.")),
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
			guestBash(`${prefix}${posixShellQuoted(claudeBin)} auth status`),
			8_000,
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

function listClaudeModels(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	claudeBin: string,
	_keyEnvPath: string | null,
): Effect.Effect<readonly ListedModel[]> {
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			guestBash(`${posixShellQuoted(claudeBin)} --help`),
			15_000,
		),
	).pipe(
		Effect.map((result) => {
			const help = `${result.stdout}\n${result.stderr}`;
			const fromHelp = parseClaudeModelFlagsFromHelp(help);
			const capabilities = parseClaudeCapabilitiesFromHelp(help);
			if (fromHelp.length > 0) {
				return fromHelp.map((model) => ({
					...model,
					...(capabilities.reasoning
						? { reasoning: capabilities.reasoning }
						: {}),
					...(capabilities.supportsFastMode ? { supportsFastMode: true } : {}),
				}));
			}
			return [];
		}),
		Effect.catchAll(() => Effect.succeed([] as const)),
	);
}

function failed(message: string): ClaudeAuthStatus {
	return { stage: "failed", message };
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
		if (kind === "reasoning") {
			const summaries = Array.isArray(row.summaries)
				? row.summaries.filter(
						(summary): summary is string =>
							typeof summary === "string" && summary.length > 0,
					)
				: [];
			items.push({
				kind: "reasoning",
				id: SessionItemId(id),
				summaries,
				...(typeof row.durationSeconds === "number"
					? { durationSeconds: row.durationSeconds }
					: {}),
			});
		}
		if (kind === "commandExecution" && readString(row.command)) {
			items.push({
				kind: "commandExecution",
				id: SessionItemId(id),
				command: String(row.command),
				cwd: readString(row.cwd) ?? null,
				status: toolActivityStatus(row.status),
				output: readString(row.output) ?? null,
				exitCode: typeof row.exitCode === "number" ? row.exitCode : null,
			});
		}
		if (kind === "dynamicToolCall" && readString(row.tool)) {
			const status = toolActivityStatus(row.status);
			items.push({
				kind: "dynamicToolCall",
				id: SessionItemId(id),
				tool: String(row.tool),
				status: status === "declined" ? "failed" : status,
			});
		}
	}
	return items;
}

function toolActivityStatus(value: unknown): ToolActivityStatus {
	if (
		value === "completed" ||
		value === "failed" ||
		value === "declined" ||
		value === "inProgress"
	) {
		return value;
	}
	return "inProgress";
}

function writeClaudeThinkingSettings(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	home: string,
): Effect.Effect<void> {
	const path = claudeSettingsPath(home);
	return Effect.gen(function* () {
		const existing = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, path),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const parent = path.slice(0, path.lastIndexOf("/"));
		yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				guestBash(`mkdir -p ${posixShellQuoted(parent)}`),
				10_000,
			),
		);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				path,
				claudeSettingsShowingThoughts(existing),
			),
		);
	}).pipe(Effect.catchAll(() => Effect.void));
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
		const supportsFastMode = listedModelSupportsFastMode(row);
		const fastModeId = listedFastModeId(row);
		const reasoning = listedReasoningFromRow(row);
		models.push({
			id,
			label,
			...(notice ? { notice } : {}),
			...(supportsFastMode ? { supportsFastMode } : {}),
			...(fastModeId ? { fastModeId } : {}),
			...(reasoning ? { reasoning } : {}),
		});
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
		readonly reasoningEffort?: string;
		readonly fast?: boolean;
		readonly readOnly?: boolean;
		readonly peerSessionId?: string;
	},
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const current = yield* refreshClaudeAuthStatus(machines, workspaceId);
		if (current.stage !== "authenticated") return current;
		if (current.authMode !== "apikey")
			return failed("Add your Anthropic API key in the model picker.");
		const locate = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, guestBash(LOCATE_CLAUDE), 15_000),
		);
		const claudeBin = parseClaudeBinaryPath(locate.stdout);
		if (locate.exitCode !== 0 || !claudeBin) {
			return failed("Claude Code is not installed on this workspace");
		}
		const home = parseClaudeHomePath(locate.stdout);
		if (home) {
			yield* writeClaudeThinkingSettings(machines, workspaceId, home);
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
		yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				guestBash(
					`rm -f ${TURN_OUT_PATH} ${TURN_ERR_PATH} ${TURN_EXIT_PATH} ${TURN_PID_PATH}`,
				),
				10_000,
			),
		);
		yield* persistClaudeStatus(machines, workspaceId, running);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(workspaceId, TURN_PTY_PATH, TURN_PTY_SOURCE),
		);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				TASK_TOOL_SERVER_PATH,
				TASK_TOOL_SERVER_SOURCE,
			),
		);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				TASK_TOOL_CONFIG_PATH,
				TASK_TOOL_CONFIG,
			),
		);
		const keyPrefix = `. ${KEY_ENV_PATH}\n: "\${ANTHROPIC_API_KEY:?Anthropic API key is required}"\n`;
		yield* Effect.tryPromise(async () => {
			await machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-peer-hook.py",
				PEER_INBOX_SOURCE,
			);
			await machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-peer-hooks.json",
				JSON.stringify({
					hooks: Object.fromEntries(
						[
							"UserPromptSubmit",
							"PostToolUse",
							"PostToolUseFailure",
							"Stop",
						].map((event) => [
							event,
							[
								{
									hooks: [
										{
											type: "command",
											command: `python3 /tmp/ytimesy-peer-hook.py ${PEER_INBOX_PATH} hook ${posixShellQuoted(input.peerSessionId ?? "unbound")}`,
											timeout: 5,
										},
									],
								},
							],
						]),
					),
				}),
			);
		});
		const prompt = input.promptText ?? input.text;
		const reasoningFlag = input.reasoningEffort
			? ` --effort ${posixShellQuoted(input.reasoningEffort)}`
			: "";
		const fastFlag = input.fast ? " --fast" : "";
		const permissionFlag = input.readOnly
			? " --permission-mode plan"
			: " --dangerously-skip-permissions";
		const systemPrompt = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, DEVELOPER_INSTRUCTIONS_PATH),
		).pipe(
			Effect.catchAll(() => Effect.succeed(AGENT_ORCHESTRATION_INSTRUCTIONS)),
		);
		const start = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				guestBash(
					`${keyPrefix}
(
  python3 ${TURN_PTY_PATH} ${TURN_OUT_PATH} ${TURN_ERR_PATH} -- ${posixShellQuoted(claudeBin)} -p --output-format stream-json --verbose --include-partial-messages${permissionFlag} --strict-mcp-config --mcp-config ${TASK_TOOL_CONFIG_PATH} --settings /tmp/ytimesy-peer-hooks.json --append-system-prompt ${posixShellQuoted(systemPrompt?.trim() || AGENT_ORCHESTRATION_INSTRUCTIONS)} --model ${posixShellQuoted(input.modelId)}${reasoningFlag}${fastFlag} ${posixShellQuoted(prompt)}
  echo $? >${TURN_EXIT_PATH}
) >/dev/null 2>&1 &
echo $! >${TURN_PID_PATH}`,
				),
				15_000,
			),
		);
		if (start.exitCode !== 0) {
			const failedStart: ClaudeAuthStatus = {
				...running,
				turnStatus: "failed",
				items: [
					...running.items,
					{
						kind: "error",
						id: SessionItemId(`claude-error-${Date.now()}`),
						message:
							(start.stderr || start.stdout).trim() ||
							"Claude Code did not start the turn.",
					},
				],
			};
			yield* persistClaudeStatus(machines, workspaceId, failedStart);
			return failedStart;
		}
		return running;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failed(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

function syncClaudeBackgroundTurn(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	current: Extract<ClaudeAuthStatus, { stage: "authenticated" }>,
): Effect.Effect<ClaudeAuthStatus> {
	return Effect.gen(function* () {
		const probe = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				guestBash(
					`if [ -f ${TURN_PID_PATH} ]; then echo PID_PRESENT; fi
if [ -f ${TURN_PID_PATH} ] && kill -0 "$(cat ${TURN_PID_PATH})" 2>/dev/null; then echo ALIVE; fi
if [ -f ${TURN_EXIT_PATH} ]; then echo EXIT_PRESENT; fi`,
				),
				10_000,
			),
		);
		const output = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, TURN_OUT_PATH),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const exitText = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, TURN_EXIT_PATH),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const result = claudeBackgroundTurnResult({
			exitText,
			output,
			pidAlive: probe.stdout.includes("ALIVE"),
			pidFilePresent: probe.stdout.includes("PID_PRESENT"),
		});
		const items = claudeTurnItemsFromStream({
			previousItems: current.items,
			stream: output,
		});
		if (result.kind === "running") {
			const running = { ...current, items };
			yield* persistClaudeStatus(machines, workspaceId, running);
			return running;
		}
		const next: ClaudeAuthStatus =
			result.kind === "completed"
				? {
						...current,
						turnStatus: "completed",
						items,
					}
				: {
						...current,
						turnStatus: "failed",
						items: items.some((item) => item.kind === "error")
							? items
							: [
									...items,
									{
										kind: "error",
										id: SessionItemId(`claude-error-${Date.now()}`),
										message: result.message,
									},
								],
					};
		yield* persistClaudeStatus(machines, workspaceId, next);
		return next;
	}).pipe(Effect.catchAll(() => Effect.succeed(current)));
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

export function snapshotAuthenticatedClaudeWorkspace(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<
	| { readonly ok: true; readonly snapshotId: string; readonly public: false }
	| { readonly ok: false; readonly message: string }
> {
	return Effect.gen(function* () {
		const locate = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, guestBash(LOCATE_CLAUDE), 15_000),
		);
		const claudeBin = parseClaudeBinaryPath(locate.stdout);
		if (!claudeBin) {
			return {
				ok: false as const,
				message: "Claude Code is not installed on this workspace",
			};
		}
		const live = yield* probeClaudeCli(machines, workspaceId, claudeBin, null);
		if (live.stage !== "authenticated") {
			return {
				ok: false as const,
				message: "Refusing to snapshot without Anthropic sign-in",
			};
		}
		const scrubbed = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				guestBash(REMOVE_CODEX_CREDENTIAL_FILES),
				15_000,
			),
		);
		if (scrubbed.exitCode !== 0) {
			return {
				ok: false as const,
				message: "Could not isolate provider credentials before snapshot.",
			};
		}
		const snapshot = yield* Effect.tryPromise(() =>
			machines.snapshotAuthenticatedWorkspace(workspaceId, "claude"),
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
				message: failureMessage(cause),
			}),
		),
	);
}
