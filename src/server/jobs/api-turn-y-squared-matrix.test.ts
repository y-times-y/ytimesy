/**
 * Y² has no machine. A real turn can have many conditions (a step, a resumed
 * step, hooks, memory, secrets, a lean surface, a queued message ...); none of
 * them may make a Y² turn reach for a workspace. The machines passed in throw
 * on any property access, the workspace preparations are probes, and the
 * model runtime is a stand-in that calls what the real loop calls around every
 * request (prepareMessages, beforeStep, compaction hooks, afterTools, onStep)
 * and then runs the tools the model could call. The real tool set, tool
 * surface, repository context, lifecycle hooks and turn-end code run.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ClaudeRunnerTransportFailure,
	Y_SQUARED_NO_WORKSPACE,
} from "#/domain/api-turn-failure";
import { claudeCodeTurnRevision } from "#/domain/claude-code-route";
import type { ClaudeRunnerBox } from "#/domain/claude-runner";
import { SessionItemId } from "#/domain/ids";
import { ySquaredInstructions } from "#/domain/y-squared";
import type { ApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	yMode: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
	renew: vi.fn(),
	finalize: vi.fn(),
	stop: vi.fn(),
	stepRuntime: vi.fn(),
	enqueue: vi.fn(),
	result: vi.fn(),
	owner: vi.fn(),
	commit: vi.fn(),
	progress: vi.fn(),
	startQueued: vi.fn(async (..._args: unknown[]) => false),
	peerInbox: vi.fn(),
	checkpoint: vi.fn(),
	cancelRequested: vi.fn(),
	variant: vi.fn(),
	turnMemory: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
	/** The user's configured MCP servers: a Y² turn must never even load them. */
	mcpServers: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
	/** Any workspace preparation of a normal chat; Y² must never reach it. */
	workspace: vi.fn(),
	checkedOut: vi.fn((): Promise<unknown> | undefined => undefined),
	preparedDirectory: vi.fn(),
	baseline: vi.fn(),
	hookConfig: vi.fn(),
	projectSecrets: vi.fn(),
	writeSecrets: vi.fn(async (..._args: unknown[]) => undefined),
	attachments: vi.fn(async (..._args: unknown[]) => {}),
	commandCompletions: vi.fn(),
	codePoint: vi.fn(async (..._args: unknown[]) => {}),
	imported: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
	/** Y² on the Claude Code route: the step that would start `claude`. */
	claudeStep: vi.fn(async (...args: unknown[]): Promise<unknown> => {
		const input = args[0] as {
			onEvent: (event: unknown) => Promise<void>;
		};
		await input.onEvent({ type: "text-delta", id: "t1", text: "All quiet." });
		return {
			messages: [{ role: "assistant", content: "All quiet." }],
			outcome: "completed",
		};
	}),
	claudeStop: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../services/claude-code-turn", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/claude-code-turn")>()),
	runClaudeCodeTurnStep: (...args: unknown[]) => mocks.claudeStep(...args),
	stopClaudeCodeTurnRun: (...args: unknown[]) => mocks.claudeStop(...args),
}));
/** Y² never delivers peer messages to anything but its own history. */

vi.mock("../adapters/prepared-checkout", () => ({
	MACHINE_PREWARM_KEY: "machine-prewarm",
	readPreparedCheckoutDirectory: mocks.preparedDirectory,
	savePreparedCheckoutDirectory: vi.fn(async () => {}),
	readSessionDerivedValue: mocks.hookConfig,
	readProjectDerivedValue: vi.fn(async () => null),
	saveSessionDerivedValue: vi.fn(async () => {}),
}));
vi.mock("../services/turn-memory", () => ({
	turnMemory: mocks.turnMemory,
	subagentMemory: vi.fn(async () => null),
}));
vi.mock("../adapters/dev-eval-users", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/dev-eval-users")>()),
	devEvalUsersEnabled: () => mocks.variant() !== undefined,
	harnessVariantForUser: async () => mocks.variant(),
	isDevEvalUser: async () => false,
}));
vi.mock("../adapters/harness-evaluation", () => ({
	evaluationRunForTask: vi.fn(async () => ({
		id: "evaluation",
		taskId: "task",
		attempt: 1,
	})),
	reserveEvaluationRequest: vi.fn(async () => {}),
	recordEvaluationUsage: vi.fn(async () => {}),
	assertEvaluationActive: vi.fn(async () => {}),
}));
vi.mock("../services/fusion-lead", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/fusion-lead")>()),
	fusionLeadGate: vi.fn(async () => "ready"),
}));
vi.mock("../adapters/context-archives", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/context-archives")>()),
	archiveModelContext: vi.fn(async () => ({ id: "archive" })),
}));
vi.mock("../adapters/mcp-servers", () => ({
	connectableMcpServers: mocks.mcpServers,
}));
vi.mock("../adapters/plugin-installs", () => ({
	enabledPluginSkillIndex: async () => [],
	pluginSkillBody: async () => null,
}));
vi.mock("../services/api-agent-command-tools", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../services/api-agent-command-tools")
	>()),
	completedAgentCommands: mocks.commandCompletions,
}));
vi.mock("../services/turn-commit", () => ({
	commitSessionTurn: mocks.commit,
}));
vi.mock("../services/queued-user-messages", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../services/queued-user-messages")
	>()),
	startQueuedUserTurn: mocks.startQueued,
}));
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: vi.fn(async () => null),
	recordCloudProjectReport: vi.fn(async () => undefined),
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: mocks.renew,
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: mocks.checkpoint,
	publishApiTurnProgress: mocks.progress,
	apiTurnCancelRequested: mocks.cancelRequested,
	replaceSettledTurnItem: vi.fn(async () => true),
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	agentSessionMetadataForOwner: mocks.owner,
	agentSessionAncestorMetadata: async () => [],
	listSidebarAgentSessions: vi.fn(async () => []),
}));
vi.mock("../adapters/y-mode", () => ({ projectYMode: mocks.yMode }));
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: vi.fn(async () => ({ revision: "revision" })),
}));
vi.mock("../adapters/agent-task-events", () => ({
	releaseHeldAgentTaskEvents: async () => 0,
	saveAgentTaskResultAndEvent: mocks.result,
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("../adapters/server-peer-inbox", () => ({
	injectServerPeerMessages: mocks.peerInbox,
}));
// The real catch-up needs the database; a workspace read in it is what to catch.
vi.mock("../services/fresh-machine-setup", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/fresh-machine-setup")>()),
	withSetupCatchUp: async (
		input: Parameters<
			typeof import("../services/fresh-machine-setup").withSetupCatchUp
		>[0],
	) => {
		await input.workspace();
		return { messages: input.messages, changed: false };
	},
}));
vi.mock("../adapters/api-usage-budget", () => ({ reserveApiTokens: vi.fn() }));
vi.mock("../services/message-attachments", async (original) => ({
	...(await original<typeof import("../services/message-attachments")>()),
	materializeMessageAttachments: (...args: unknown[]) =>
		mocks.attachments(...args),
}));
vi.mock("../services/conversation-recovery", () => ({
	ensureConversationCodePoint: mocks.codePoint,
}));
vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: mocks.baseline,
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: vi.fn(async () => true),
}));
vi.mock("../services/api-command-scope", () => ({
	COMMAND_SCOPES_DIRECTORY: "/tmp/ytimesy-api-command-scopes",
	stopApiTurnCommands: mocks.stop,
}));
vi.mock("../services/project-secrets", () => ({
	loadAgentProjectSecrets: mocks.projectSecrets,
	writeAgentProjectSecrets: mocks.writeSecrets,
}));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: mocks.stepRuntime,
	runApiAgentStep: mocks.stepRuntime,
}));
vi.mock("../services/api-turn-workspace", () => ({
	deferredApiTurnWorkspace: (machines: unknown) => {
		let prepared: Promise<unknown> | undefined;
		return Object.assign(
			() => {
				prepared ??= mocks.workspace(machines);
				return prepared;
			},
			{
				pinnedBase: async () => null,
				pinnedBaseFile: async () => null,
				plannedDirectory: async () => null,
				checkedOut: () => mocks.checkedOut(),
			},
		);
	},
}));
vi.mock("../services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
vi.mock("../services/subagent-runtime", async (original) => ({
	...(await original<typeof import("../services/subagent-runtime")>()),
	subagentReport: async (input: { text: string }) => input.text,
}));
vi.mock("../adapters/local-imports", async (original) => ({
	...(await original<typeof import("../adapters/local-imports")>()),
	projectImportedSessions: mocks.imported,
}));

/** What the matrix varies. Every field has a default (a plain first step). */
type Condition = {
	stepIndex: 1 | 2;
	resumed: boolean;
	/** The chat has earlier turns (continued) rather than being new. */
	continued: boolean;
	providerRef: string | null;
	environment: "none" | "setup" | "template";
	secrets: "none" | "runtime" | "other";
	memory: "off" | "on" | "on-with-clone";
	hooks: "none" | "prompt" | "all";
	/** The tool surface variant: lean (the product's) or the shell surface. */
	surface: "lean" | "current";
	variant: Record<string, unknown>;
	attachments: boolean;
	evaluation: boolean;
	sideChat: boolean;
	wake: boolean;
	queued: boolean;
	largeHistory: boolean;
	/** Step 2 follows a tool result (ask_user, threads). */
	toolResult: "none" | "ask_user" | "threads";
	catchUp: boolean;
	handoffs: boolean;
	reportedDirectory: boolean;
	/** The real model loop (a scripted model) instead of the stand-in. */
	real: boolean;
	/** An earlier turn's background command is still open in the transcript. */
	openCommand: boolean;
	/** The turn runs on the Claude Code route (Y² needs a Claude runner box). */
	claude: boolean;
};

const BASE: Condition = {
	stepIndex: 1,
	resumed: false,
	continued: false,
	providerRef: null,
	environment: "setup",
	secrets: "none",
	memory: "off",
	hooks: "none",
	surface: "lean",
	variant: {},
	attachments: false,
	evaluation: false,
	sideChat: false,
	wake: false,
	queued: false,
	largeHistory: false,
	toolResult: "none",
	catchUp: false,
	handoffs: false,
	reportedDirectory: false,
	real: false,
	openCommand: false,
	claude: false,
};

// biome-ignore lint/suspicious/noExplicitAny: the model loop's input is large and only probed here
type LoopInput = Record<string, any>;

const machines = new Proxy({} as WorkspaceMachines, {
	get: (_target, name) => {
		throw new Error(`Y² touched machines.${String(name)}`);
	},
});

/** Errors the simulated runtime saw from a callback or a tool of the turn. */
const seen: { where: string; error: unknown }[] = [];
/** Warnings that show a swallowed workspace read (they would not fail the turn). */
const warned: string[] = [];

function memoryStub(withClone: boolean) {
	return {
		mode: "on" as const,
		instructions: "Memory.",
		tools: {},
		prepareVm: vi.fn(async () => {
			if (!withClone) return;
		}),
		vmTokens: () => [],
		releaseVm: vi.fn(async () => {}),
		attach: vi.fn(async (messages: unknown) => ({ messages, recall: null })),
		recordSaved: (items: unknown) => items,
	};
}

function turnFor(c: Condition, id: string): ApiTurn {
	const user: Record<string, unknown> = {
		kind: "userMessage",
		id: SessionItemId(c.wake ? "wake-message" : "user"),
		text: c.wake ? "A pull request was merged." : "What are my threads doing?",
	};
	if (c.attachments)
		user.attachments = [
			{ name: "a.png", mimeType: "image/png", size: 1, id: "attachment" },
		];
	const items: Record<string, unknown>[] = [];
	const messages: Record<string, unknown>[] = [];
	if (c.continued) {
		items.push(
			{ kind: "userMessage", id: SessionItemId("earlier"), text: "Earlier." },
			{ kind: "agentMessage", id: SessionItemId("earlier-reply"), text: "OK." },
		);
		messages.push(
			{ role: "user", content: "Earlier." },
			{ role: "assistant", content: "OK." },
		);
	}
	if (c.largeHistory)
		messages.push({ role: "user", content: "filler ".repeat(40_000) });
	items.push(user);
	messages.push({ role: "user", content: String(user.text) });
	if (c.openCommand)
		items.push({
			kind: "dynamicToolCall",
			id: SessionItemId("earlier-command"),
			tool: "start_command",
			status: "completed",
			output: JSON.stringify({
				id: "b6794616-ec28-4390-831f-7d3ddf9f8621",
				status: "running",
			}),
		});
	if (c.toolResult !== "none") {
		const name = c.toolResult;
		items.push({
			kind: "dynamicToolCall",
			id: SessionItemId(`${id}:call-1`),
			tool: name,
			status: "completed",
			output: "{}",
		});
		messages.push(
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: name,
						input: {},
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: name,
						output: { type: "json", value: { ok: true } },
					},
				],
			},
		);
	}
	return {
		id,
		session_id: "session",
		user_id: "owner",
		connection_id: c.claude ? null : "connection",
		connection_revision: c.claude ? claudeCodeTurnRevision() : "revision",
		model_id: "claude-sonnet-5-5",
		state: "running",
		messages,
		items,
		lease_id: "lease",
	} as unknown as ApiTurn;
}

/**
 * Stands in for the model loop: the callbacks the real one calls around each
 * request, then every tool the model could call that takes no machine.
 */
async function simulatedLoop(input: LoopInput, c: Condition) {
	const attempt = async (where: string, run: () => unknown) => {
		try {
			await run();
		} catch (error) {
			seen.push({ where, error });
		}
	};
	let history = input.messages;
	await attempt("prepareMessages", async () => {
		history = (await input.prepareMessages?.(history)) ?? history;
	});
	await attempt("beforeStep", () => input.beforeStep?.(history));
	if (c.largeHistory) {
		await attempt("beforeCompaction", () => input.beforeCompaction?.(history));
		await attempt("archiveHistory", () => input.archiveHistory?.(history));
		await attempt("restoreInstructions", () =>
			input.restoreInstructions?.(history),
		);
		await attempt("compactionSnapshot", () =>
			input.compactionSnapshot?.(history, new AbortController().signal),
		);
	}
	for (const [name, definition] of Object.entries<LoopInput>(
		input.tools ?? {},
	)) {
		if (!definition?.execute) continue;
		// These start, message or stop other chats with the person's own send
		// path, which is allowed machines.
		if (/^(start|message|stop)_thread$/.test(name)) continue;
		await attempt(`tool:${name}`, () =>
			definition.execute(
				{},
				{
					toolCallId: `call-${name}`,
					messages: history,
					abortSignal: new AbortController().signal,
					context: {},
				},
			),
		);
	}
	await attempt("afterTools", () => input.afterTools?.(history));
	await attempt("onStep", () => input.onStep?.(history));
	await input.onEvent({ type: "text-delta", id: "reply", text: "Done." });
	return { messages: history, outcome: "completed" };
}

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};

/** Calls `threads` until a tool result is in its prompt, then answers. */
function scriptedModel() {
	return new MockLanguageModelV4({
		doStream: async ({ prompt }: { prompt: { role: string }[] }) => {
			const answered = prompt.some((message) => message.role === "tool");
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: (answered
						? [
								{ type: "text-start", id: "t" },
								{ type: "text-delta", id: "t", delta: "Two threads." },
								{ type: "text-end", id: "t" },
								{
									type: "finish",
									finishReason: { unified: "stop", raw: "stop" },
									usage,
								},
							]
						: [
								{
									type: "tool-call",
									toolCallId: "call-real",
									toolName: "threads",
									input: "{}",
								},
								{
									type: "finish",
									finishReason: { unified: "tool-calls", raw: "tool_calls" },
									usage,
								},
							]) as never,
				}) as never,
			};
		},
	} as never);
}

/** The real model loop: a step is a request, then its tools, then the next step. */
async function realLoop(input: LoopInput) {
	const { runModelAgentStep } = await import("../services/model-agent-loop");
	let current = input as Parameters<typeof runModelAgentStep>[0];
	for (let round = 0; round < 3; round++) {
		const result = await runModelAgentStep(current, {
			model: scriptedModel(),
			contextWindow: 200_000,
		});
		if (result.outcome === "completed") return result;
		current = { ...current, messages: result.messages };
	}
	throw new Error("The scripted model never finished.");
}

async function runCase(overrides: Partial<Condition>) {
	const c: Condition = { ...BASE, ...overrides };
	seen.length = 0;
	warned.length = 0;
	const product = (await import("#/domain/harness-variant"))
		.PRODUCT_HARNESS_VARIANT;
	mocks.variant.mockReturnValue({
		...product,
		toolSurface: c.surface,
		y: "on",
		...c.variant,
	});
	process.env.YTIMESY_HARNESS_EVALUATION_ENABLED = c.evaluation ? "1" : "";
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		taskAccess: "read_write",
		providerRef: c.providerRef,
		environmentId: c.environment === "none" ? null : "environment",
		templateId: c.environment === "template" ? "template" : null,
		listedModelId: "claude-sonnet-5-5",
		...(c.sideChat ? { agentBudget: { sideChat: true } } : {}),
	});
	mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "session" });
	mocks.projectSecrets.mockResolvedValue(
		c.secrets === "none"
			? { envFile: "", redact: [], names: [] }
			: {
					envFile: "export TOKEN=secret",
					redact: ["secret"],
					names: [{ name: "TOKEN", kind: c.secrets }],
				},
	);
	mocks.imported.mockResolvedValue(
		c.handoffs ? [{ id: "imported", title: "Local session" }] : [],
	);
	if (c.memory === "off") mocks.turnMemory.mockResolvedValue(null);
	else
		mocks.turnMemory.mockResolvedValue(
			memoryStub(c.memory === "on-with-clone"),
		);
	if (c.hooks !== "none") {
		mocks.baseline.mockResolvedValue("a".repeat(40));
		mocks.hookConfig.mockResolvedValue({
			version: 1,
			hooks: [
				{ event: "UserPromptSubmit", command: "true", timeoutSeconds: 5 },
				...(c.hooks === "all"
					? [
							{ event: "Stop", command: "true", timeoutSeconds: 5 },
							{ event: "PreToolUse", command: "true", timeoutSeconds: 5 },
							{ event: "PostToolUse", command: "true", timeoutSeconds: 5 },
							{ event: "PostCompact", command: "true", timeoutSeconds: 5 },
						]
					: []),
			],
		});
	} else {
		mocks.baseline.mockResolvedValue(null);
		mocks.hookConfig.mockResolvedValue(null);
	}
	mocks.preparedDirectory.mockResolvedValue(
		c.reportedDirectory ? "/repo" : null,
	);
	mocks.peerInbox.mockImplementation(
		async (
			_id: string,
			history: unknown,
			_checkpoint: unknown,
			_delivered: unknown,
			onSetupCatchUp?: () => void,
		) => {
			if (c.catchUp) onSetupCatchUp?.();
			return history;
		},
	);
	mocks.startQueued.mockResolvedValue(c.queued);
	mocks.stepRuntime.mockImplementation((input: LoopInput) =>
		c.real ? realLoop(input) : simulatedLoop(input, c),
	);
	const outcome = await runApiTurn(
		machines,
		turnFor(c, `turn-${c.stepIndex}`),
		{
			index: c.stepIndex,
			resumed: c.resumed,
			signal: new AbortController().signal,
		} as never,
		c.claude
			? {
					...(await import("./turn-ports-local")).localTurnPorts,
					pinnedClaudeRunner: (runner: ClaudeRunnerBox) => runner,
					claudeSubscriptionStatus: async () => ({
						status: "connected",
						message: null,
						limitedUntil: null,
						connectedAt: 0,
					}),
				}
			: undefined,
	);
	return { outcome, c };
}

function expectNoWorkspace(outcome: string, c: Condition) {
	const why = JSON.stringify(c);
	const failure = mocks.finalize.mock.calls.find(
		([, state]) => state === "failed",
	);
	expect(JSON.stringify(failure), `the turn failed: ${why}`).toBeUndefined();
	for (const { where, error } of seen) {
		const text = error instanceof Error ? error.stack : String(error);
		expect(text, `${where} reached a workspace: ${why}`).not.toMatch(
			/has no workspace|touched machines/,
		);
	}
	expect(warned, `a workspace read was swallowed: ${why}`).toEqual([]);
	expect(["completed", "continue"], why).toContain(outcome);
	expect(mocks.workspace, `workspace prepared: ${why}`).not.toHaveBeenCalled();
	expect(mocks.checkedOut, `checked out: ${why}`).not.toHaveBeenCalled();
	expect(mocks.commit, `committed: ${why}`).not.toHaveBeenCalled();
	expect(
		mocks.attachments,
		`attachments written: ${why}`,
	).not.toHaveBeenCalled();
	expect(mocks.writeSecrets, `secrets written: ${why}`).not.toHaveBeenCalled();
	expect(mocks.codePoint, `code point: ${why}`).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		const text = String(args[0]);
		if (
			/Conversation history file|Background commands were not observed|Compaction state snapshot/.test(
				text,
			)
		)
			warned.push(text);
	});
	mocks.renew.mockReset().mockResolvedValue(true);
	mocks.progress.mockReset().mockResolvedValue(undefined);
	mocks.checkpoint.mockReset().mockResolvedValue(undefined);
	mocks.cancelRequested.mockReset().mockResolvedValue(false);
	mocks.finalize.mockReset().mockImplementation(async (_turn, state) => state);
	mocks.commit.mockReset().mockResolvedValue(undefined);
	mocks.stop.mockReset().mockResolvedValue(undefined);
	mocks.commandCompletions.mockReset().mockResolvedValue([]);
	mocks.result.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
	mocks.workspace
		.mockReset()
		.mockImplementation(async () => ({ machines: {}, vm: "vm", cwd: "/repo" }));
	mocks.checkedOut.mockReset().mockReturnValue(undefined);
	vi.mocked(coordinateConversationTurn).mockReset().mockResolvedValue(true);
});

const BOOLEAN_AXES = {
	stepIndex: [1, 2] as const,
	resumed: [false, true],
	providerRef: [null, "vm-1"],
	surface: ["lean", "current"] as const,
	hooks: ["none", "prompt"] as const,
	catchUp: [false, true],
};

function crossProduct(): Partial<Condition>[] {
	let rows: Partial<Condition>[] = [{}];
	for (const [key, values] of Object.entries(BOOLEAN_AXES))
		rows = rows.flatMap((row) =>
			(values as readonly unknown[]).map((value) => ({
				...row,
				[key]: value,
			})),
		);
	return rows;
}

describe("a Y² turn never reaches a workspace, whatever else is true of it", () => {
	it("control: the same stand-in loop does prepare a workspace for a normal chat", async () => {
		mocks.stepRuntime.mockImplementation((input: LoopInput) =>
			simulatedLoop(input, BASE),
		);
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).PRODUCT_HARNESS_VARIANT,
		});
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			taskAccess: "read_write",
		});
		mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "another" });
		mocks.projectSecrets.mockResolvedValue({
			envFile: "",
			redact: [],
			names: [],
		});
		mocks.peerInbox.mockImplementation(async (_id: string, h: unknown) => h);
		await runApiTurn({} as WorkspaceMachines, turnFor(BASE, "turn-control"), {
			index: 1,
			signal: new AbortController().signal,
		});
		expect(mocks.workspace).toHaveBeenCalled();
	});

	it.each(
		crossProduct().flatMap((row) =>
			[false, true].map(
				(real) => [JSON.stringify({ ...row, real }), { ...row, real }] as const,
			),
		),
	)("axes %s", async (_name, row) => {
		const { outcome, c } = await runCase(row);
		expectNoWorkspace(outcome, c);
	});

	const SINGLE: [string, Partial<Condition>][] = [
		["a continued chat", { continued: true }],
		["a continued chat at step 2", { continued: true, stepIndex: 2 }],
		["no environment", { environment: "none" }],
		["a template project", { environment: "template" }],
		["runtime secrets", { secrets: "runtime" }],
		["non-runtime secrets", { secrets: "other" }],
		["runtime secrets at step 2", { secrets: "runtime", stepIndex: 2 }],
		["memory on", { memory: "on" }],
		["memory on with a clone", { memory: "on-with-clone" }],
		[
			"memory on with a clone at step 2",
			{ memory: "on-with-clone", stepIndex: 2 },
		],
		["every lifecycle hook", { hooks: "all" }],
		["every lifecycle hook at step 2", { hooks: "all", stepIndex: 2 }],
		[
			"a reported directory with a UserPromptSubmit hook",
			{
				hooks: "prompt",
				reportedDirectory: true,
				providerRef: "vm-1",
			},
		],
		["a reported directory", { reportedDirectory: true, providerRef: "vm-1" }],
		["a reported directory, no hooks, new chat", { reportedDirectory: true }],
		["attachments", { attachments: true }],
		["attachments at step 2", { attachments: true, stepIndex: 2 }],
		["an evaluation run", { evaluation: true }],
		["a side conversation", { sideChat: true }],
		["a wake message", { wake: true }],
		["a wake message at step 2", { wake: true, stepIndex: 2 }],
		["a queued message", { queued: true }],
		["a queued message at step 2", { queued: true, stepIndex: 2 }],
		["a history that needs compaction", { largeHistory: true }],
		[
			"a history that needs compaction at step 2",
			{
				largeHistory: true,
				stepIndex: 2,
				continued: true,
			},
		],
		["imported sessions", { handoffs: true }],
		["an open background command", { openCommand: true, continued: true }],
		[
			"an open background command at step 2",
			{
				openCommand: true,
				continued: true,
				stepIndex: 2,
				largeHistory: true,
			},
		],
		["y on", { variant: { y: "on" } }],
		["review on", { variant: { review: "on" } }],
		["subagents on", { variant: { subagents: "on" } }],
		["subagents forced", { variant: { subagents: "force" } }],
		["three attempts", { variant: { attempts: "3" } }],
		[
			"lead fusion with a thin lead",
			{
				variant: { lead: "fusion", leadTools: "thin" },
			},
		],
		[
			"lead fusion with a full lead",
			{
				variant: { lead: "fusion", leadTools: "full" },
			},
		],
		["planning tools", { variant: { plan: "on" } }],
		["goal mode", { variant: { goal: "on" } }],
		["code mode on", { variant: { codeMode: "on" } }],
		["code mode primary", { variant: { codeMode: "primary" } }],
		[
			"code mode on, the shell surface",
			{
				variant: { codeMode: "on" },
				surface: "current",
			},
		],
		[
			"the lean-native surface",
			{ surface: "lean", variant: { toolSurface: "lean-native" } },
		],
		[
			"rigor, checker pair and output cap",
			{
				variant: { rigor: "on", checkerMode: "pair", outputCap: "on" },
			},
		],
		[
			"an ask_user result at step 2",
			{
				stepIndex: 2,
				continued: true,
				toolResult: "ask_user",
			},
		],
		[
			"a threads result at step 2",
			{
				stepIndex: 2,
				continued: true,
				toolResult: "threads",
			},
		],
		[
			"a resumed threads result at step 2",
			{
				stepIndex: 2,
				resumed: true,
				toolResult: "threads",
			},
		],
		[
			"everything at once, step 2",
			{
				stepIndex: 2,
				resumed: true,
				continued: true,
				providerRef: "vm-1",
				environment: "template",
				secrets: "runtime",
				memory: "on-with-clone",
				hooks: "all",
				attachments: true,
				wake: true,
				queued: true,
				largeHistory: true,
				toolResult: "threads",
				catchUp: true,
				handoffs: true,
				reportedDirectory: true,
				variant: { plan: "on", codeMode: "on", subagents: "on", review: "on" },
			},
		],
		[
			"everything at once, step 1",
			{
				providerRef: "vm-1",
				environment: "template",
				secrets: "other",
				memory: "on-with-clone",
				hooks: "all",
				attachments: true,
				wake: true,
				queued: true,
				largeHistory: true,
				catchUp: true,
				handoffs: true,
				reportedDirectory: true,
				evaluation: false,
				variant: { plan: "on", codeMode: "primary", subagents: "force" },
			},
		],
	];

	it.each(
		SINGLE.flatMap(([name, row]) => [
			[name, row] as const,
			[`${name} (the real model loop)`, { ...row, real: true }] as const,
		]),
	)("%s", async (_name, row) => {
		const { outcome, c } = await runCase(row);
		expectNoWorkspace(outcome, c);
	});

	it("a failure from the refused workspace logs where it came from, never what was said", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const refused = () => new Error(Y_SQUARED_NO_WORKSPACE);
			mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "session" });
			mocks.owner.mockResolvedValue({
				id: "session",
				userId: "owner",
				projectId: "project",
				harness: "api",
				taskAccess: "read_write",
			});
			mocks.projectSecrets.mockResolvedValue({
				envFile: "",
				redact: [],
				names: [],
			});
			mocks.peerInbox.mockImplementation(async (_id: string, h: unknown) => h);
			mocks.stepRuntime.mockImplementation(async () => {
				throw refused();
			});
			const outcome = await runApiTurn(
				machines,
				turnFor(BASE, "turn-refused"),
				{ index: 1, signal: new AbortController().signal } as never,
			);
			expect(outcome).toBe("failed");
			const logged = warn.mock.calls.find(
				([message]) => message === "API turn failed",
			)?.[1] as { stage: string; stack?: string; cause?: string } | undefined;
			expect(logged?.stage).toBe("model");
			expect(logged?.stack).toMatch(/refused/);
			expect((logged?.stack ?? "").split(" | ").length).toBeLessThanOrEqual(10);
			expect(logged?.stack).not.toContain("Y² has no workspace");
			expect(logged?.stack).not.toContain("What are my threads doing?");
		} finally {
			warn.mockRestore();
		}
	});

	it("another failure logs no stack", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "session" });
			mocks.owner.mockResolvedValue({
				id: "session",
				userId: "owner",
				projectId: "project",
				harness: "api",
				taskAccess: "read_write",
			});
			mocks.projectSecrets.mockResolvedValue({
				envFile: "",
				redact: [],
				names: [],
			});
			mocks.peerInbox.mockImplementation(async (_id: string, h: unknown) => h);
			mocks.stepRuntime.mockImplementation(async () => {
				throw new Error("Something else");
			});
			await runApiTurn(machines, turnFor(BASE, "turn-other"), {
				index: 1,
				signal: new AbortController().signal,
			} as never);
			const logged = warn.mock.calls.find(
				([message]) => message === "API turn failed",
			)?.[1] as { stack?: string } | undefined;
			expect(logged).toBeDefined();
			expect(logged?.stack).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("Y² on the Claude Code route", () => {
	const keys = [
		"YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED",
		"YTIMESY_CLAUDE_RUNNER_URLS",
		"YTIMESY_CLAUDE_RUNNER_SIGNING_KEY",
		"YTIMESY_CLAUDE_RUNNER_USERS",
		"YTIMESY_CLAUDE_RUNNER_SESSIONS",
	] as const;
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of keys) saved[key] = process.env[key];
		process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
		mocks.claudeStep.mockClear();
		mocks.claudeStop.mockClear();
	});
	afterEach(() => {
		for (const key of keys)
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
	});
	const withRunner = () => {
		process.env.YTIMESY_CLAUDE_RUNNER_URLS = "https://runner.example";
		process.env.YTIMESY_CLAUDE_RUNNER_SIGNING_KEY = "A".repeat(64);
		process.env.YTIMESY_CLAUDE_RUNNER_USERS = "owner";
		delete process.env.YTIMESY_CLAUDE_RUNNER_SESSIONS;
	};

	it("starts Claude with no workspace, no machines and Y²'s prompt and tools", async () => {
		withRunner();
		const { outcome } = await runCase({ claude: true });
		expect(mocks.claudeStep).toHaveBeenCalledOnce();
		const step = mocks.claudeStep.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(step.workspace).toBeUndefined();
		expect(step.machines).toBeUndefined();
		expect(step.ySquared).toEqual({
			instructions: ySquaredInstructions(),
		});
		expect(step.runner).toMatchObject({
			box: { baseUrl: "https://runner.example" },
			workspaceTools: [],
		});
		expect((step.runner as Record<string, unknown>).boxTools).toBeUndefined();
		expect(Object.keys(step.tools as object).sort()).toEqual(
			[
				"archive_thread",
				"ask_user",
				"list_models",
				"message_thread",
				"read_canvas",
				"retry_thread",
				"schedule",
				"set_thread_model",
				"show_canvas",
				"start_thread",
				"stop_thread",
				"thread",
				"threads",
				"view_image",
			].sort(),
		);
		expect(outcome).toBe("completed");
		expectNoWorkspace(outcome, { ...BASE, claude: true });
	});

	it("without a runner it never starts Claude and says what is missing", async () => {
		delete process.env.YTIMESY_CLAUDE_RUNNER_URLS;
		await runCase({ claude: true });
		expect(mocks.claudeStep).not.toHaveBeenCalled();
		const failed = mocks.finalize.mock.calls.find(
			([, state]) => state === "failed",
		);
		expect(JSON.stringify(failed)).toContain(
			"Y² on a Claude subscription needs the Claude runner",
		);
		expect(JSON.stringify(failed)).not.toContain("ytimesy bug");
	});

	it("a runner that cannot be reached is an outage the failover mechanism handles, never a ytimesy bug", async () => {
		withRunner();
		mocks.claudeStep.mockRejectedValueOnce(
			new ClaudeRunnerTransportFailure("exec", "network"),
		);
		const { outcome } = await runCase({ claude: true });
		// Reuses the existing outage handling: a retry on the route, then
		// another route; the turn does not fail on the spot.
		expect(["continue", "failed-over"]).toContain(outcome);
		expect(JSON.stringify(mocks.finalize.mock.calls)).not.toContain(
			"ytimesy bug",
		);
	});
});

describe("the user's MCP servers never reach a Y² turn", () => {
	// A configured server that cannot be reached (nothing listens on port 1).
	const broken = {
		id: "gitlab",
		name: "gitlab-gitlab",
		url: "http://127.0.0.1:1/mcp",
		auth: "none",
		headers: {},
	};
	const notices = () =>
		(
			mocks.stepRuntime.mock.calls.flatMap(
				(call) =>
					((call[0] as LoopInput).messages ?? []) as { content: unknown }[],
			) as { content: unknown }[]
		)
			.map((message) => String(message.content))
			.filter((content) => content.includes("MCP servers"));
	beforeEach(() => {
		mocks.mcpServers.mockReset();
		mocks.mcpServers.mockResolvedValue([broken]);
		mocks.stepRuntime.mockReset();
	});

	it("api route: loads no MCP server and adds no 'unavailable' notice", async () => {
		const { outcome } = await runCase({});
		expect(outcome).toBe("completed");
		expect(mocks.mcpServers).not.toHaveBeenCalled();
		expect(notices()).toEqual([]);
	});

	it("Claude Code route: loads no MCP server and adds no notice either", async () => {
		const keys = [
			"YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED",
			"YTIMESY_CLAUDE_RUNNER_URLS",
			"YTIMESY_CLAUDE_RUNNER_SIGNING_KEY",
			"YTIMESY_CLAUDE_RUNNER_USERS",
		] as const;
		const saved = keys.map((key) => process.env[key]);
		process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
		process.env.YTIMESY_CLAUDE_RUNNER_URLS = "https://runner.example";
		process.env.YTIMESY_CLAUDE_RUNNER_SIGNING_KEY = "A".repeat(64);
		process.env.YTIMESY_CLAUDE_RUNNER_USERS = "owner";
		mocks.claudeStep.mockClear();
		try {
			await runCase({ claude: true });
			expect(mocks.claudeStep).toHaveBeenCalledOnce();
			expect(mocks.mcpServers).not.toHaveBeenCalled();
			const step = mocks.claudeStep.mock.calls[0]?.[0] as {
				messages: { content: unknown }[];
			};
			expect(
				step.messages.some((message) =>
					String(message.content).includes("MCP servers"),
				),
			).toBe(false);
		} finally {
			keys.forEach((key, index) => {
				if (saved[index] === undefined) delete process.env[key];
				else process.env[key] = saved[index];
			});
		}
	});

	it("api route with a tool result and a later step: still none", async () => {
		await runCase({ stepIndex: 2, resumed: true, toolResult: "threads" });
		expect(mocks.mcpServers).not.toHaveBeenCalled();
		expect(notices()).toEqual([]);
	});

	it("control: a normal chat loads them and is told which are unavailable", async () => {
		mocks.stepRuntime.mockImplementation((input: LoopInput) =>
			simulatedLoop(input, BASE),
		);
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).PRODUCT_HARNESS_VARIANT,
		});
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			taskAccess: "read_write",
		});
		mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "another" });
		mocks.projectSecrets.mockResolvedValue({
			envFile: "",
			redact: [],
			names: [],
		});
		mocks.peerInbox.mockImplementation(async (_id: string, h: unknown) => h);
		await runApiTurn(
			{} as WorkspaceMachines,
			turnFor(BASE, "turn-control-mcp"),
			{
				index: 1,
				signal: new AbortController().signal,
			},
		);
		expect(mocks.mcpServers).toHaveBeenCalled();
		expect(notices().join("\n")).toContain("gitlab-gitlab");
	});
});
