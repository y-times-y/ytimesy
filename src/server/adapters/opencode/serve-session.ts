import { Duration, Effect } from "effect";
import { fileChangesFromGitPorcelain } from "#/domain/git-working-tree";
import { SessionItemId, type WorkspaceId } from "#/domain/ids";
import type { ListedModel } from "#/domain/listed-model";
import { parseOpenCodeModelCatalog } from "#/domain/opencode-catalog";
import { sessionItemsFromOpenCodeMessages } from "#/domain/opencode-session-items";
import {
	assistantTextFromOpenCode,
	assistantTextFromOpenCodeMessages,
	assistantTextFromOpenCodeTurn,
	errorMessageFromOpenCode,
	openCodeAbortAccepted,
	openCodeAbortFailureMessage,
	openCodeSessionIsBusy,
	openCodeTurnFailureMessage,
	openCodeTurnPollDecision,
} from "#/domain/opencode-turn";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	type FileChangeEntry,
	lastAgentMessageText,
	type SessionItem,
	type SessionTurnStatus,
	sessionTurnLooksSettled,
	type ToolActivityStatus,
} from "#/domain/session-item";
import {
	guestCliDisableUpdateExports,
	pinnedOpenCodeInstallCommand,
} from "#/domain/guest-cli-pin";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { ensureGuestCliPin } from "#/server/adapters/guest-cli-pin";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const STATUS_PATH = "/tmp/ytimesy-opencode-status.json";
const PID_PATH = "/tmp/ytimesy-opencode-serve.pid";
const LOG_PATH = "/tmp/ytimesy-opencode-serve.log";
const AUTH_BODY_PATH = "/tmp/ytimesy-opencode-auth.json";
const OPENCODE_PORT = 4096;
const OPENCODE_ORIGIN = `http://127.0.0.1:${OPENCODE_PORT}`;
const WORKING_TREE_ITEM_ID = SessionItemId("opencode-working-tree");
const READ_WORKING_TREE = `python3 - <<'PY'
import json, os, subprocess
cwd_file = ${JSON.stringify(PROJECT_CWD_PATH)}
cwd = open(cwd_file).read().strip() if os.path.isfile(cwd_file) else ""
if not cwd:
    cwd = os.path.expanduser("~/ytimesy")
if not os.path.isdir(os.path.join(cwd, ".git")):
    print(json.dumps({"porcelain": "", "previews": {}}))
    raise SystemExit
porcelain = subprocess.check_output(["git", "-C", cwd, "status", "--porcelain=v1"], text=True)
previews = {}
for line in porcelain.splitlines():
    if len(line) < 4:
        continue
    path = line[3:].split(" -> ")[-1].strip().strip('"')
    full = os.path.join(cwd, path)
    code = line[:2]
    if code == "??" and os.path.isfile(full) and os.path.getsize(full) < 50000:
        previews[path] = open(full, errors="replace").read()[:4000]
        continue
    if "M" in code or code.strip() == "A":
        diff = subprocess.check_output(["git", "-C", cwd, "diff", "--", path], text=True)
        if diff:
            previews[path] = diff[:4000]
print(json.dumps({"porcelain": porcelain, "previews": previews}))
PY`;

export const OPENCODE_LOCATE_BIN_SCRIPT = `set -eu
${guestCliDisableUpdateExports()}
export HOME="\${HOME:-/root}"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
  exit 1
fi
echo "OPENCODE_BIN=$(command -v opencode)"
`;

const INSTALL_SCRIPT = `set -eu
${guestCliDisableUpdateExports()}
export HOME="\${HOME:-/root}"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
  ${pinnedOpenCodeInstallCommand()}
fi
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_BIN="$(command -v opencode)"
else
  echo "opencode binary not found after install" >&2
  exit 1
fi
echo "OPENCODE_BIN=$OPENCODE_BIN"
"$OPENCODE_BIN" --version
`;

export const OPENCODE_START_SERVE_SCRIPT = `set -eu
${guestCliDisableUpdateExports()}
CWD_FILE=${PROJECT_CWD_PATH}
if [ -f "$CWD_FILE" ]; then
  SERVE_CWD="$(tr -d '\\n\\r' < "$CWD_FILE")"
  if [ -n "$SERVE_CWD" ] && [ -d "$SERVE_CWD" ]; then
    cd "$SERVE_CWD"
  fi
fi
SECRETS_FILE="\${HOME:-/home/ubuntu}/.ytimesy-agent-secrets.env"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  . "$SECRETS_FILE"
  set +a
fi
if [ -f ${PID_PATH} ] && kill -0 "$(cat ${PID_PATH})" 2>/dev/null; then
  echo "SERVE_PID=$(cat ${PID_PATH})"
  exit 0
fi
if curl -fsS ${OPENCODE_ORIGIN}/global/health >/dev/null 2>&1; then
  echo "SERVE_ALREADY_UP"
  exit 0
fi
setsid "$OPENCODE_BIN" serve --port ${OPENCODE_PORT} --hostname 127.0.0.1 >${LOG_PATH} 2>&1 < /dev/null &
echo $! > ${PID_PATH}
echo "SERVE_PID=$(cat ${PID_PATH})"
`;
const START_SERVE_SCRIPT = OPENCODE_START_SERVE_SCRIPT;

export type OpenCodeAuthStatus =
	| { readonly stage: "missing" }
	| { readonly stage: "starting" }
	| {
			readonly stage: "authenticated";
			readonly authMode: "local" | "apikey";
			readonly planType: string | null;
			readonly models: readonly ListedModel[];
			readonly turnStatus: SessionTurnStatus;
			readonly items: readonly SessionItem[];
			readonly serveSessionId: string | null;
			readonly seenBusy: boolean;
			readonly turnStartedAt: number | null;
			readonly lastBusyAt: number | null;
	  }
	| { readonly stage: "failed"; readonly message: string };

export function dropCopiedOpenCodeTranscript(
	status: OpenCodeAuthStatus,
): OpenCodeAuthStatus {
	if (status.stage !== "authenticated") return status;
	return {
		...status,
		turnStatus: "idle",
		items: status.items.filter((item) => item.kind === "fileChange"),
		serveSessionId: null,
		seenBusy: false,
		turnStartedAt: null,
		lastBusyAt: null,
	};
}

export function parseOpenCodeAuthStatus(
	contents: string | null,
): OpenCodeAuthStatus {
	if (!contents) return { stage: "missing" };
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!isRecord(parsed)) {
			return { stage: "failed", message: "OpenCode status was not an object" };
		}
		const stage = readString(parsed.stage);
		if (stage === "starting") return { stage: "starting" };
		if (stage === "awaiting_device_code") return { stage: "missing" };
		if (stage === "authenticated") {
			return {
				stage: "authenticated",
				authMode: parsed.authMode === "apikey" ? "apikey" : "local",
				planType: readString(parsed.planType) ?? null,
				models: Array.isArray(parsed.models)
					? parseOpenCodeModelCatalog(parsed.models)
					: [],
				turnStatus:
					parsed.turnStatus === "running" ||
					parsed.turnStatus === "completed" ||
					parsed.turnStatus === "failed"
						? parsed.turnStatus
						: "idle",
				items: simpleSessionItems(parsed.items),
				serveSessionId: readString(parsed.serveSessionId) ?? null,
				seenBusy: parsed.seenBusy === true,
				turnStartedAt:
					typeof parsed.turnStartedAt === "number"
						? parsed.turnStartedAt
						: null,
				lastBusyAt:
					typeof parsed.lastBusyAt === "number" ? parsed.lastBusyAt : null,
			};
		}
		if (stage === "failed") {
			return {
				stage: "failed",
				message: readString(parsed.message) ?? "OpenCode connect failed",
			};
		}
		return {
			stage: "failed",
			message: `Unknown OpenCode stage: ${stage ?? "absent"}`,
		};
	} catch (cause) {
		return {
			stage: "failed",
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

export function readOpenCodeAuthStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.tryPromise(() =>
		machines.readTextFile(workspaceId, STATUS_PATH),
	).pipe(
		Effect.map(parseOpenCodeAuthStatus),
		Effect.catchAll(() => Effect.succeed({ stage: "missing" as const })),
	);
}

/**
 * Installs OpenCode and starts `opencode serve`. No account login is required.
 * A stored key is optional and is attached only if the server accepts it.
 */
export function connectOpenCode(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	apiKey: string | null,
	options?: { readonly discardCopiedTranscript?: boolean },
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		yield* ensureGuestCliPin(machines, workspaceId);
		const located = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, OPENCODE_LOCATE_BIN_SCRIPT, 15_000),
		);
		const install =
			located.exitCode === 0
				? located
				: yield* Effect.tryPromise(() =>
						machines.exec(workspaceId, INSTALL_SCRIPT, 240_000),
					);
		if (install.exitCode !== 0) {
			return failed(
				`OpenCode install failed: ${(install.stderr || install.stdout).trim()}`,
			);
		}
		const opencodeBin = firstMatch(install.stdout, /^OPENCODE_BIN=(.+)$/m);
		if (!opencodeBin) {
			return failed("OpenCode install succeeded without reporting a binary");
		}
		const start = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`export OPENCODE_BIN=${posixShellQuoted(opencodeBin)}
${START_SERVE_SCRIPT}`,
				30_000,
			),
		);
		if (start.exitCode !== 0) {
			return failed(
				`Failed to start opencode serve: ${(start.stderr || start.stdout).trim()}`,
			);
		}
		const healthy = yield* waitForHealth(machines, workspaceId);
		if (!healthy) {
			const log = yield* Effect.tryPromise(() =>
				machines.readTextFile(workspaceId, LOG_PATH),
			);
			return failed(
				`opencode serve did not become healthy${log ? `: ${log.slice(-500)}` : ""}`,
			);
		}

		let usedKey = false;
		if (apiKey) {
			usedKey = yield* putOpenCodeAuth(machines, workspaceId, apiKey);
		}

		const snapshot = yield* readOpenCodeSnapshot(
			machines,
			workspaceId,
			usedKey,
		);
		const connected = options?.discardCopiedTranscript
			? dropCopiedOpenCodeTranscript(snapshot)
			: snapshot;
		yield* persistStatus(machines, workspaceId, connected);
		return connected;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				failed(cause instanceof Error ? cause.message : String(cause)),
			),
		),
	);
}

export function refreshOpenCodeAuthStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const health = yield* curlJson(machines, workspaceId, "/global/health");
		if (health == null) {
			const previous = yield* readOpenCodeAuthStatus(machines, workspaceId);
			const turnRunning =
				previous.stage === "authenticated" && previous.turnStatus === "running";
			if (!turnRunning) {
				const restarted = yield* restartOpenCodeServe(machines, workspaceId);
				if (!restarted) {
					return previous;
				}
			}
		}
		let snapshot = yield* readOpenCodeSnapshot(machines, workspaceId);
		if (
			snapshot.stage === "authenticated" &&
			snapshot.turnStatus === "running"
		) {
			snapshot = yield* syncOpenCodeTurn(machines, workspaceId, snapshot);
		}
		yield* persistStatus(machines, workspaceId, snapshot);
		return snapshot;
	}).pipe(Effect.catchAll(() => readOpenCodeAuthStatus(machines, workspaceId)));
}

function waitForHealth(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const health = yield* curlJson(machines, workspaceId, "/global/health");
			if (isRecord(health) && health.healthy === true) return true;
			yield* Effect.sleep(Duration.seconds(1));
		}
		return false;
	});
}

function putOpenCodeAuth(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	apiKey: string,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				AUTH_BODY_PATH,
				`${JSON.stringify({ type: "api", key: apiKey })}\n`,
			),
		);
		const result = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`curl -sS -o /tmp/ytimesy-opencode-auth-result.txt -w '%{http_code}' -X PUT ${OPENCODE_ORIGIN}/auth/opencode -H 'Content-Type: application/json' --data-binary @${AUTH_BODY_PATH}; echo; rm -f ${AUTH_BODY_PATH}`,
				30_000,
			),
		);
		const code = (result.stdout || "").trim().split("\n").at(-1) ?? "";
		return code.startsWith("2");
	}).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

function readOpenCodeSnapshot(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	usedKey = false,
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const catalog =
			(yield* curlJson(machines, workspaceId, "/config/providers")) ??
			(yield* curlJson(machines, workspaceId, "/api/model"));
		const models = parseOpenCodeModelCatalog(catalog);
		const previous = yield* readOpenCodeAuthStatus(machines, workspaceId);
		const previousItems =
			previous.stage === "authenticated" ? previous.items : [];
		const previousTurn =
			previous.stage === "authenticated" ? previous.turnStatus : "idle";
		const serveSessionId =
			previous.stage === "authenticated" ? previous.serveSessionId : null;
		const seenBusy =
			previous.stage === "authenticated" ? previous.seenBusy : false;
		const turnStartedAt =
			previous.stage === "authenticated" ? previous.turnStartedAt : null;
		const lastBusyAt =
			previous.stage === "authenticated" ? previous.lastBusyAt : null;
		const authMode =
			usedKey ||
			(previous.stage === "authenticated" && previous.authMode === "apikey")
				? ("apikey" as const)
				: ("local" as const);
		const workingTree = yield* readWorkingTreeChanges(machines, workspaceId);
		return {
			stage: "authenticated" as const,
			authMode,
			planType: null,
			models,
			turnStatus: previousTurn,
			items: withWorkingTreeChanges(previousItems, workingTree),
			serveSessionId,
			seenBusy,
			turnStartedAt,
			lastBusyAt,
		};
	});
}

function persistStatus(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	status: OpenCodeAuthStatus,
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.writeTextFile(
			workspaceId,
			STATUS_PATH,
			`${JSON.stringify(status)}\n`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}

function readWorkingTreeChanges(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<readonly FileChangeEntry[]> {
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, READ_WORKING_TREE, 20_000),
	).pipe(
		Effect.map((result) => parseWorkingTreePayload(result.stdout)),
		Effect.catchAll(() => Effect.succeed([])),
	);
}

function parseWorkingTreePayload(raw: string): readonly FileChangeEntry[] {
	try {
		const parsed: unknown = JSON.parse(raw.trim());
		if (!isRecord(parsed) || typeof parsed.porcelain !== "string") return [];
		const previews = isRecord(parsed.previews)
			? Object.fromEntries(
					Object.entries(parsed.previews).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
		return fileChangesFromGitPorcelain(parsed.porcelain, previews);
	} catch {
		return [];
	}
}

function withWorkingTreeChanges(
	items: readonly SessionItem[],
	changes: readonly FileChangeEntry[],
): SessionItem[] {
	const withoutTree = items.filter((item) => item.id !== WORKING_TREE_ITEM_ID);
	if (changes.length === 0) return [...withoutTree];
	return [
		...withoutTree,
		{
			kind: "fileChange",
			id: WORKING_TREE_ITEM_ID,
			status: "completed",
			changes,
		},
	];
}

function curlJson(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	path: string,
): Effect.Effect<unknown | null> {
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`curl -fsS ${OPENCODE_ORIGIN}${path} || true`,
			15_000,
		),
	).pipe(
		Effect.map((result) => {
			const text = result.stdout.trim();
			if (!text) return null;
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return null;
			}
		}),
		Effect.catchAll(() => Effect.succeed(null)),
	);
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
							typeof summary === "string" && summary.trim().length > 0,
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
		if (
			kind === "mcpToolCall" &&
			readString(row.server) &&
			readString(row.tool)
		) {
			const status = toolActivityStatus(row.status);
			items.push({
				kind: "mcpToolCall",
				id: SessionItemId(id),
				server: String(row.server),
				tool: String(row.tool),
				status: status === "declined" ? "failed" : status,
			});
		}
		if (kind === "webSearch") {
			items.push({
				kind: "webSearch",
				id: SessionItemId(id),
				query: readString(row.query) ?? null,
			});
		}
		if (kind === "plan" && readString(row.text)) {
			items.push({
				kind: "plan",
				id: SessionItemId(id),
				text: String(row.text),
			});
		}
		if (kind === "fileChange") {
			const changes = fileChangeEntries(row.changes);
			if (changes.length > 0) {
				items.push({
					kind: "fileChange",
					id: SessionItemId(id),
					status: toolActivityStatus(row.status),
					changes,
				});
			}
		}
	}
	return items;
}

function fileChangeEntries(value: unknown): readonly FileChangeEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: FileChangeEntry[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const path = readString(row.path);
		if (!path) continue;
		const change =
			row.change === "add" || row.change === "delete" || row.change === "update"
				? row.change
				: null;
		if (!change) continue;
		entries.push({
			path,
			change,
			additions: typeof row.additions === "number" ? row.additions : 0,
			deletions: typeof row.deletions === "number" ? row.deletions : 0,
			preview: typeof row.preview === "string" ? row.preview : null,
		});
	}
	return entries;
}

function toolActivityStatus(value: unknown): ToolActivityStatus {
	if (
		value === "inProgress" ||
		value === "failed" ||
		value === "declined" ||
		value === "completed"
	) {
		return value;
	}
	return "completed";
}

function failed(message: string): OpenCodeAuthStatus {
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

export function abortedOpenCodeTurn(
	current: Extract<OpenCodeAuthStatus, { stage: "authenticated" }>,
): Extract<OpenCodeAuthStatus, { stage: "authenticated" }> {
	return {
		...current,
		turnStatus: "idle",
		seenBusy: false,
		turnStartedAt: null,
		lastBusyAt: null,
	};
}

/**
 * Stops a running OpenCode turn through official `POST /session/:id/abort`.
 * Abort is not a provider failure: the composer goes idle unless the abort
 * request itself fails.
 */
export function abortOpenCodeTurn(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const current = yield* readOpenCodeAuthStatus(machines, workspaceId);
		if (current.stage !== "authenticated") return current;
		if (current.turnStatus !== "running") return current;
		if (current.serveSessionId) {
			const response = yield* curlHttp(
				machines,
				workspaceId,
				"POST",
				`/session/${current.serveSessionId}/abort`,
				"",
				20_000,
			);
			if (!openCodeAbortAccepted(response)) {
				return yield* failOpenCodeTurn(
					machines,
					workspaceId,
					current,
					openCodeAbortFailureMessage({
						payload: response.body ?? response.raw,
						httpStatus: response.status,
					}),
				);
			}
		}
		const stopped = abortedOpenCodeTurn(current);
		yield* persistStatus(machines, workspaceId, stopped);
		return stopped;
	}).pipe(Effect.catchAll(() => readOpenCodeAuthStatus(machines, workspaceId)));
}

export function submitOpenCodeTask(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly promptText?: string;
		readonly variant?: string;
	},
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const current = yield* refreshOpenCodeAuthStatus(machines, workspaceId);
		if (current.stage !== "authenticated") return current;
		const userItem: SessionItem = {
			kind: "userMessage",
			id: SessionItemId(`opencode-user-${Date.now()}`),
			text: input.text,
		};
		const running: Extract<OpenCodeAuthStatus, { stage: "authenticated" }> = {
			...current,
			turnStatus: "running",
			items: [...current.items, userItem],
			seenBusy: false,
			turnStartedAt: Date.now(),
			lastBusyAt: null,
		};
		yield* persistStatus(machines, workspaceId, running);
		const directory = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, PROJECT_CWD_PATH),
		).pipe(
			Effect.map((value) => value?.trim() || null),
			Effect.catchAll(() => Effect.succeed(null)),
		);
		let sessionId = running.serveSessionId;
		if (!sessionId) {
			const created = yield* curlHttp(
				machines,
				workspaceId,
				"POST",
				"/session",
				JSON.stringify({
					title: input.text.slice(0, 80),
					...(directory ? { directory } : {}),
				}),
				30_000,
			);
			const createdId = isRecord(created.body)
				? readString(created.body.id)
				: undefined;
			sessionId = createdId ?? null;
			if (!sessionId) {
				return yield* failOpenCodeTurn(
					machines,
					workspaceId,
					running,
					"opencode serve did not create a session.",
				);
			}
		}
		const [providerID, modelID] = splitOpenCodeModelId(input.modelId);
		const body = JSON.stringify({
			model: { providerID, modelID },
			...(input.variant?.trim()
				? { variant: input.variant.trim() }
				: {}),
			parts: [{ type: "text", text: input.promptText ?? input.text }],
		});
		const queued: Extract<OpenCodeAuthStatus, { stage: "authenticated" }> = {
			...running,
			serveSessionId: sessionId,
		};
		let asyncReply = yield* curlHttp(
			machines,
			workspaceId,
			"POST",
			`/session/${sessionId}/prompt_async`,
			body,
			30_000,
		);
		for (
			let attempt = 0;
			attempt < 3 && asyncReply.status === 404;
			attempt += 1
		) {
			yield* Effect.sleep(Duration.seconds(1));
			asyncReply = yield* curlHttp(
				machines,
				workspaceId,
				"POST",
				`/session/${sessionId}/prompt_async`,
				body,
				30_000,
			);
		}
		if (asyncReply.status === 404) {
			const response = yield* curlHttp(
				machines,
				workspaceId,
				"POST",
				`/session/${sessionId}/message`,
				body,
				180_000,
			);
			if (response.status >= 400) {
				return yield* failOpenCodeTurn(
					machines,
					workspaceId,
					queued,
					openCodeTurnFailureMessage({
						payload: response.body ?? response.raw,
						httpStatus: response.status,
					}),
				);
			}
			const text =
				assistantTextFromOpenCode(response.body) ??
				assistantTextFromOpenCodeMessages(response.body);
			if (text) {
				return yield* finishOpenCodeTurn(
					machines,
					workspaceId,
					queued,
					response,
				);
			}
			yield* persistStatus(machines, workspaceId, queued);
			return queued;
		}
		if (asyncReply.status >= 400) {
			return yield* failOpenCodeTurn(
				machines,
				workspaceId,
				queued,
				openCodeTurnFailureMessage({
					payload: asyncReply.body ?? asyncReply.raw,
					httpStatus: asyncReply.status,
				}),
			);
		}
		yield* persistStatus(machines, workspaceId, queued);
		return queued;
	});
}

function restartOpenCodeServe(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		const start = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if command -v opencode >/dev/null 2>&1; then
  export OPENCODE_BIN="$(command -v opencode)"
${START_SERVE_SCRIPT}
fi`,
				30_000,
			),
		);
		if (start.exitCode !== 0) return false;
		return yield* waitForHealth(machines, workspaceId);
	}).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

function syncOpenCodeTurn(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	current: Extract<OpenCodeAuthStatus, { stage: "authenticated" }>,
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		if (!current.serveSessionId) {
			return yield* failOpenCodeTurn(
				machines,
				workspaceId,
				current,
				"OpenCode turn is running without a session id.",
			);
		}
		const status = yield* curlHttp(
			machines,
			workspaceId,
			"GET",
			"/session/status",
			"",
			20_000,
		);
		const messages = yield* curlHttp(
			machines,
			workspaceId,
			"GET",
			`/session/${current.serveSessionId}/message`,
			"",
			20_000,
		);
		const busy = openCodeSessionIsBusy(status.body, current.serveSessionId);
		const error =
			errorMessageFromOpenCode(messages.body) ??
			errorMessageFromOpenCode(status.body);
		const workingTree = yield* readWorkingTreeChanges(machines, workspaceId);
		const mapped = sessionItemsFromOpenCodeMessages(messages.body);
		const items = withWorkingTreeChanges(
			mapped.length > 0 ? mapped : current.items,
			workingTree,
		);
		const text =
			assistantTextFromOpenCodeTurn(messages.body) ??
			(sessionTurnLooksSettled(items)
				? lastAgentMessageText(items)
				: null);
		const now = Date.now();
		const lastBusyAt = busy ? now : current.lastBusyAt;
		const seenBusy = current.seenBusy || busy;
		const decision = openCodeTurnPollDecision({
			busy,
			seenBusy,
			hasNewAssistantText: Boolean(text),
			hasError: Boolean(error),
			elapsedMs: now - (current.turnStartedAt ?? now),
			msSinceLastBusy: lastBusyAt === null ? null : now - lastBusyAt,
		});
		if (decision === "running") {
			return {
				...current,
				items,
				seenBusy,
				lastBusyAt,
			};
		}
		if (decision === "completed" && text) {
			const withoutAgentErrors = items.filter((item) => item.kind !== "error");
			const already = withoutAgentErrors.some(
				(item) => item.kind === "agentMessage" && item.text === text,
			);
			return {
				...current,
				turnStatus: "completed" as const,
				items: already
					? withoutAgentErrors
					: [
							...withoutAgentErrors,
							{
								kind: "agentMessage" as const,
								id: SessionItemId(`opencode-agent-${Date.now()}`),
								text,
							},
						],
				seenBusy,
				lastBusyAt,
			};
		}
		return yield* failOpenCodeTurn(
			machines,
			workspaceId,
			{ ...current, items, seenBusy, lastBusyAt },
			error ??
				openCodeTurnFailureMessage({
					payload: messages.body ?? status.body,
					httpStatus: messages.status,
				}),
		);
	});
}

function finishOpenCodeTurn(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	current: Extract<OpenCodeAuthStatus, { stage: "authenticated" }>,
	response: CurlHttpResult,
): Effect.Effect<OpenCodeAuthStatus> {
	const text =
		assistantTextFromOpenCode(response.body) ??
		assistantTextFromOpenCodeMessages(response.body);
	if (text) {
		const completed: OpenCodeAuthStatus = {
			...current,
			turnStatus: "completed",
			items: [
				...current.items,
				{
					kind: "agentMessage",
					id: SessionItemId(`opencode-agent-${Date.now()}`),
					text,
				},
			],
		};
		return persistStatus(machines, workspaceId, completed).pipe(
			Effect.map(() => completed),
		);
	}
	return failOpenCodeTurn(
		machines,
		workspaceId,
		current,
		openCodeTurnFailureMessage({
			payload: response.body ?? response.raw,
			httpStatus: response.status,
		}),
	);
}

function failOpenCodeTurn(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	current: Extract<OpenCodeAuthStatus, { stage: "authenticated" }>,
	message: string,
): Effect.Effect<OpenCodeAuthStatus> {
	const failedTurn: OpenCodeAuthStatus = {
		...current,
		turnStatus: "failed",
		items: [
			...current.items,
			{
				kind: "error",
				id: SessionItemId(`opencode-error-${Date.now()}`),
				message,
			},
		],
	};
	return persistStatus(machines, workspaceId, failedTurn).pipe(
		Effect.map(() => failedTurn),
	);
}

function splitOpenCodeModelId(modelId: string): [string, string] {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return ["opencode", modelId];
	return [modelId.slice(0, slash), modelId.slice(slash + 1)];
}

export type CurlHttpResult = {
	readonly status: number;
	readonly body: unknown | null;
	readonly raw: string;
};

function curlHttp(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	method: "POST" | "GET",
	path: string,
	body: string,
	timeoutMs: number,
): Effect.Effect<CurlHttpResult> {
	const dataFlag =
		method === "GET" || body === ""
			? ""
			: ` -H 'Content-Type: application/json' --data ${posixShellQuoted(body)}`;
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`curl -sS -X ${method} ${OPENCODE_ORIGIN}${path}${dataFlag} -w '\\n%{http_code}'`,
			timeoutMs,
		),
	).pipe(
		Effect.map((result) => parseCurlHttp(result.stdout)),
		Effect.catchAll(() =>
			Effect.succeed({
				status: 0,
				body: null,
				raw: "",
			} satisfies CurlHttpResult),
		),
	);
}

export function parseCurlHttp(stdout: string): CurlHttpResult {
	const trimmed = stdout.replace(/\s+$/, "");
	const lastNl = trimmed.lastIndexOf("\n");
	const statusText = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
	const raw = lastNl === -1 ? "" : trimmed.slice(0, lastNl);
	const status = Number.parseInt(statusText, 10);
	let body: unknown | null = null;
	if (raw.trim()) {
		try {
			body = JSON.parse(raw) as unknown;
		} catch {
			body = raw;
		}
	}
	return {
		status: Number.isFinite(status) ? status : 0,
		body,
		raw,
	};
}
