import { Duration, Effect } from "effect";
import { SessionItemId, type WorkspaceId } from "#/domain/ids";
import type { ListedModel } from "#/domain/listed-model";
import { parseOpenCodeModelCatalog } from "#/domain/opencode-catalog";
import { posixShellQuoted } from "#/domain/posix-command";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const STATUS_PATH = "/tmp/ytimesy-opencode-status.json";
const PID_PATH = "/tmp/ytimesy-opencode-serve.pid";
const LOG_PATH = "/tmp/ytimesy-opencode-serve.log";
const AUTH_BODY_PATH = "/tmp/ytimesy-opencode-auth.json";
const OPENCODE_PORT = 4096;
const OPENCODE_ORIGIN = `http://127.0.0.1:${OPENCODE_PORT}`;

const INSTALL_SCRIPT = `set -eu
export HOME="\${HOME:-/root}"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash
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

const START_SERVE_SCRIPT = `set -eu
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
	  }
	| { readonly stage: "failed"; readonly message: string };

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
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const install = yield* Effect.tryPromise(() =>
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
		yield* persistStatus(machines, workspaceId, snapshot);
		return snapshot;
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
			return yield* readOpenCodeAuthStatus(machines, workspaceId);
		}
		const snapshot = yield* readOpenCodeSnapshot(machines, workspaceId);
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
			(yield* curlJson(machines, workspaceId, "/api/model")) ??
			(yield* curlJson(machines, workspaceId, "/config/providers"));
		const models = parseOpenCodeModelCatalog(catalog);
		const previous = yield* readOpenCodeAuthStatus(machines, workspaceId);
		const previousItems =
			previous.stage === "authenticated" ? previous.items : [];
		const previousTurn =
			previous.stage === "authenticated" ? previous.turnStatus : "idle";
		const authMode =
			usedKey ||
			(previous.stage === "authenticated" && previous.authMode === "apikey")
				? ("apikey" as const)
				: ("local" as const);
		return {
			stage: "authenticated" as const,
			authMode,
			planType: null,
			models,
			turnStatus: previousTurn,
			items: previousItems,
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
	}
	return items;
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

export function submitOpenCodeTask(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	input: { readonly text: string; readonly modelId: string },
): Effect.Effect<OpenCodeAuthStatus> {
	return Effect.gen(function* () {
		const current = yield* refreshOpenCodeAuthStatus(machines, workspaceId);
		if (current.stage !== "authenticated") return current;
		const userItem: SessionItem = {
			kind: "userMessage",
			id: SessionItemId(`opencode-user-${Date.now()}`),
			text: input.text,
		};
		const running: OpenCodeAuthStatus = {
			...current,
			turnStatus: "running",
			items: [...current.items, userItem],
		};
		yield* persistStatus(machines, workspaceId, running);
		const session = yield* curlJsonMethod(
			machines,
			workspaceId,
			"POST",
			"/session",
			"{}",
		);
		const sessionId =
			isRecord(session) && readString(session.id) ? session.id : null;
		if (!sessionId) {
			const failedTurn: OpenCodeAuthStatus = {
				...current,
				turnStatus: "failed",
				items: [
					...running.items,
					{
						kind: "error",
						id: SessionItemId(`opencode-error-${Date.now()}`),
						message: "opencode serve did not create a session.",
					},
				],
			};
			yield* persistStatus(machines, workspaceId, failedTurn);
			return failedTurn;
		}
		const [providerID, modelID] = splitOpenCodeModelId(input.modelId);
		const body = JSON.stringify({
			model: { providerID, modelID },
			parts: [{ type: "text", text: input.text }],
		});
		const response = yield* curlJsonMethod(
			machines,
			workspaceId,
			"POST",
			`/session/${sessionId}/message`,
			body,
		);
		const text = assistantTextFromOpenCode(response);
		const next: OpenCodeAuthStatus = text
			? {
					...current,
					turnStatus: "completed",
					items: [
						...running.items,
						{
							kind: "agentMessage",
							id: SessionItemId(`opencode-agent-${Date.now()}`),
							text,
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
							id: SessionItemId(`opencode-error-${Date.now()}`),
							message:
								"OpenCode listed no assistant text. ytimesy did not fall back to another provider.",
						},
					],
				};
		yield* persistStatus(machines, workspaceId, next);
		return next;
	});
}

function splitOpenCodeModelId(modelId: string): [string, string] {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return ["opencode", modelId];
	return [modelId.slice(0, slash), modelId.slice(slash + 1)];
}

function assistantTextFromOpenCode(payload: unknown): string | null {
	if (typeof payload === "string" && payload.trim()) return payload.trim();
	if (!isRecord(payload)) return null;
	if (typeof payload.text === "string" && payload.text.trim()) {
		return payload.text.trim();
	}
	const parts = Array.isArray(payload.parts)
		? payload.parts
		: isRecord(payload.info) && Array.isArray(payload.parts)
			? payload.parts
			: Array.isArray(payload.parts)
				? payload.parts
				: [];
	const texts: string[] = [];
	for (const part of Array.isArray(payload.parts) ? payload.parts : parts) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && readString(part.text)) {
			texts.push(String(part.text));
		}
	}
	return texts.join("\n").trim() || null;
}

function curlJsonMethod(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	method: "POST" | "GET",
	path: string,
	body: string,
): Effect.Effect<unknown | null> {
	const quotedBody = posixShellQuoted(body);
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`curl -fsS -X ${method} ${OPENCODE_ORIGIN}${path} -H 'Content-Type: application/json' --data ${quotedBody} || true`,
			180_000,
		),
	).pipe(
		Effect.map((result) => {
			const text = result.stdout.trim();
			if (!text) return null;
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return text;
			}
		}),
		Effect.catchAll(() => Effect.succeed(null)),
	);
}
