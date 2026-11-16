import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolSet } from "ai";
import { boxCallRunsOnEdge } from "#/domain/claude-box-tools";
import {
	CLAUDE_CODE_TOOL_USE_ID,
	handleMcpMessage,
	type McpCallResult,
	type McpToolDefinition,
} from "#/domain/claude-code-mcp";
import type { LeanToolShape } from "#/domain/harness-model-profile";
import { WorkspaceId } from "#/domain/ids";
import { redactSecretValues } from "#/domain/project-secret";
import { agentOutputArtifacts } from "#/server/services/agent-output-artifacts";
import type { AgentToolWorkspace } from "#/server/services/agent-tool-workspace";
import { apiAgentCommandTools } from "#/server/services/api-agent-command-tools";
import { leanShapeSurface } from "#/server/services/lean-shape-surface";
import { runToolForMcp } from "#/server/services/mcp-tool-call";
import {
	BoxMachineRefused,
	BoxRedactedWrite,
	type GuestExec,
	identityWorkspaceMachines,
} from "./identity-machines";

/**
 * ytimesy's workspace tools served on the Claude runner box itself
 * (docs/claude-code-placement.md, "Workspace tools on the box"): the run's
 * Claude Code talks MCP to this server on 127.0.0.1, and the lean tools
 * (read, write, edit, the shell, glob and grep, reading and stopping
 * commands) run here, straight against the chat's VM with the run's identity
 * token, so no call wakes the chat's Durable Object. They are the same tool
 * code as on the edge (lean-shape-surface.ts over api-agent-command-tools.ts).
 *
 * Everything else goes to the edge's MCP route as before, with the run's
 * grant: tools that need the database, the vault, GitHub, R2 or an account
 * key; a command started in the background (its exit callback is signed with
 * the edge's secret and its VM's idle timeout is raised by the account);
 * ytimesy-browser and ytimesy-job commands (their captures are stored by the
 * edge); and a local call the provider refused before running anything (a
 * paused or replaced VM, a revoked grant), which the edge can start or find.
 */
export type ClaudeBoxToolsConfig = {
	/** The identity's token (claude-box-tool-grant.ts); never logged. */
	readonly token: string;
	readonly vmId: string;
	readonly linuxUser: string;
	/** The repository on the VM. */
	readonly cwd: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly shape: LeanToolShape;
	/** The tools served here (a subset of the lean shape's). */
	readonly tools: readonly string[];
	/** Turn tokens the edge put on the VM (git, memory), removed from results. */
	readonly redact: readonly string[];
	/**
	 * The turn has runtime secrets: the VM redacts every command's output
	 * before it leaves (vm-secret-redaction.ts); their values are never here.
	 */
	readonly redactOnVm?: boolean;
};

/** Per-call bookkeeping the tool server keeps around the VM's commands. */
export type BoxCallHooks = {
	readonly onRan?: () => void;
	readonly onRedacted?: () => void;
	readonly beforeWrite?: () => void;
};

export type ClaudeBoxToolsServer = {
	/** Where Claude Code reaches this server, and the header it must send. */
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	/** The tools that run here. */
	readonly local: readonly string[];
	readonly close: () => Promise<void>;
};

const MAX_BODY = 4 * 1024 * 1024;

/** Per-process memo only: restart recovery still requires a durable journal. */
function onceInMemory() {
	const runs = new Map<
		string,
		{ fingerprint: string | undefined; running: Promise<unknown> }
	>();
	return (id: string, run: () => Promise<unknown>, fingerprint?: string) => {
		const found = runs.get(id);
		if (found) {
			if (found.fingerprint !== fingerprint)
				throw new Error(
					"Recorded tool inputs differ; no operation was replayed.",
				);
			return found.running;
		}
		// Record before execution, including synchronous failures. A rejected call
		// may have partial effects and must not become retryable under the same ID.
		const running = Promise.resolve().then(run);
		runs.set(id, { fingerprint, running });
		return running;
	};
}

/** The workspace tools over the identity's machines, built like the edge builds them. */
export function claudeBoxToolSet(
	config: ClaudeBoxToolsConfig,
	exec: GuestExec,
	signal: AbortSignal,
	hooks: BoxCallHooks & { readonly envPath?: string } = {},
): ToolSet {
	const machines = identityWorkspaceMachines({
		vmId: config.vmId,
		exec,
		...(hooks.onRan ? { onRan: hooks.onRan } : {}),
		...(config.redactOnVm
			? {
					redactOnVm: {
						...(hooks.envPath ? { envPath: hooks.envPath } : {}),
						...(hooks.onRedacted ? { onRedacted: hooks.onRedacted } : {}),
						...(hooks.beforeWrite ? { beforeWrite: hooks.beforeWrite } : {}),
					},
				}
			: {}),
	});
	const workspace: AgentToolWorkspace = {
		machines,
		vm: WorkspaceId(config.vmId),
		cwd: config.cwd,
	};
	const once = onceInMemory();
	const memos = new Map<string, Promise<unknown>>();
	const output = agentOutputArtifacts({
		workspace: async () => workspace,
		sessionId: config.sessionId,
		signal,
	});
	const base = apiAgentCommandTools({
		workspace: async () => workspace,
		output,
		turnId: config.turnId,
		sessionId: config.sessionId,
		// No userId: a background command is the edge's (boxCallRunsOnEdge).
		readOnly: false,
		signal,
		once,
	});
	const { tools } = leanShapeSurface(config.shape, base, {
		workspace: async () => workspace,
		sessionId: config.sessionId,
		turnId: config.turnId,
		toolCallPrefix: "box:",
		signal,
		once: (requestId, fingerprint, run) => once(requestId, run, fingerprint),
		memo: <T>(key: string, load: () => Promise<T>) => {
			let found = memos.get(key) as Promise<T> | undefined;
			if (!found) {
				found = load();
				memos.set(key, found);
			}
			return found;
		},
		// The edge installed them on the VM before the run (ensureLeanHelpers).
		installHelpers: async () => {},
	});
	const served = new Set(config.tools);
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => served.has(name)),
	);
}

async function forwardedCall(
	edge: { url: string; headers: Readonly<Record<string, string>> },
	fetcher: typeof fetch,
	method: string,
	params: unknown,
): Promise<unknown> {
	const response = await fetcher(edge.url, {
		method: "POST",
		headers: {
			...edge.headers,
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	if (!response.ok) throw new Error(`ytimesy answered ${response.status}.`);
	const reply = (await response.json()) as {
		result?: unknown;
		error?: { message?: string };
	};
	if (reply.error) throw new Error(reply.error.message ?? "ytimesy failed.");
	return reply.result;
}

function bearer(request: IncomingMessage, expected: Buffer) {
	const presented = /^Bearer\s+(\S+)$/i.exec(
		request.headers.authorization ?? "",
	)?.[1];
	if (!presented) return false;
	const given = Buffer.from(presented);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

async function body(request: IncomingMessage): Promise<string | null> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) return null;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Starts the server on 127.0.0.1 (an ephemeral port) behind a random bearer
 * token that exists only in this process and the Claude Code it starts.
 */
export async function startClaudeBoxTools(input: {
	readonly config: ClaudeBoxToolsConfig;
	/** The edge's MCP route and its grant header (from the run's mcp.json). */
	readonly edge: { url: string; headers: Readonly<Record<string, string>> };
	readonly exec: GuestExec;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	/** Tests only: the VM's env file (AGENT_SECRETS_ENV_PATH otherwise). */
	readonly envPath?: string;
}): Promise<ClaudeBoxToolsServer> {
	const fetcher = input.fetch ?? fetch;
	const signal = input.signal ?? new AbortController().signal;
	// Per call: whether a command reached the guest, so a refusal can be
	// handed to the edge only when nothing ran; and whether the VM redacted
	// any of its output, so the call does not write that text back.
	const calls = new AsyncLocalStorage<{ ran: boolean; redacted: boolean }>();
	const tools = claudeBoxToolSet(input.config, input.exec, signal, {
		onRan: () => {
			const call = calls.getStore();
			if (call) call.ran = true;
		},
		onRedacted: () => {
			const call = calls.getStore();
			if (call) call.redacted = true;
		},
		beforeWrite: () => {
			if (calls.getStore()?.redacted) throw new BoxRedactedWrite();
		},
		...(input.envPath ? { envPath: input.envPath } : {}),
	});
	const redact = [...input.config.redact].filter(Boolean);
	let listed: readonly McpToolDefinition[] | null = null;
	const forward = async (
		name: string,
		args: Record<string, unknown>,
		invocationId?: string,
	): Promise<McpCallResult> => {
		const result = (await forwardedCall(input.edge, fetcher, "tools/call", {
			name,
			arguments: args,
			...(invocationId === undefined
				? {}
				: { _meta: { [CLAUDE_CODE_TOOL_USE_ID]: invocationId } }),
		})) as { content?: McpCallResult["content"]; isError?: boolean };
		return {
			text: "",
			isError: result?.isError === true,
			content: result?.content ?? [],
		};
	};
	const local = async (
		name: string,
		args: Record<string, unknown>,
		invocationId?: string,
	): Promise<McpCallResult> => {
		const definition = tools[name];
		const call = { ran: false, redacted: false };
		try {
			const ran = await calls.run(call, () =>
				runToolForMcp(definition, name, args, {
					toolCallId: `box-${invocationId ?? randomUUID()}`,
					signal,
				}),
			);
			return redact.length ? redactSecretValues(ran.reply, redact) : ran.reply;
		} catch (error) {
			if (error instanceof BoxMachineRefused && !call.ran)
				return forward(name, args, invocationId);
			// Only reads ran (a write is refused before its first byte): the
			// edge redoes the call with the real text and redacts its result.
			if (error instanceof BoxRedactedWrite)
				return forward(name, args, invocationId);
			const message =
				error instanceof Error ? error.message : "The tool call failed.";
			return {
				text: redact.length ? redactSecretValues(message, redact) : message,
				isError: true,
			};
		}
	};
	const handlers = {
		tools: async () => {
			if (listed) return listed;
			const result = (await forwardedCall(
				input.edge,
				fetcher,
				"tools/list",
				{},
			)) as { tools?: McpToolDefinition[] };
			const found = result?.tools ?? [];
			if (found.length) listed = found;
			return found;
		},
		call: (
			name: string,
			args: Record<string, unknown>,
			invocationId?: string,
		) =>
			(tools[name] && !boxCallRunsOnEdge(args) ? local : forward)(
				name,
				args,
				invocationId,
			).catch(
				(error: unknown): McpCallResult => ({
					text:
						error instanceof Error ? error.message : "The tool call failed.",
					isError: true,
				}),
			),
	};
	const secret = Buffer.from(randomBytes(32).toString("hex"));
	const server = createServer(async (request, response) => {
		const reply = (status: number, json?: unknown) => {
			response.writeHead(
				status,
				json === undefined ? {} : { "content-type": "application/json" },
			);
			response.end(json === undefined ? undefined : JSON.stringify(json));
		};
		try {
			if (!bearer(request, secret)) return reply(401);
			// No server-sent stream and no session to end: plain JSON per POST.
			if (request.method !== "POST") {
				response.setHeader("allow", "POST");
				return reply(405);
			}
			const text = await body(request);
			if (text === null) return reply(413);
			let message: unknown;
			try {
				message = JSON.parse(text);
			} catch {
				return reply(400, {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error." },
				});
			}
			const answer = await handleMcpMessage(message, handlers);
			return reply(answer.status, answer.body);
		} catch {
			return reply(500);
		}
	});
	// A tool call can run for many minutes; Node's request timeout must not cut it.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		headers: { Authorization: `Bearer ${secret.toString()}` },
		local: Object.keys(tools),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
