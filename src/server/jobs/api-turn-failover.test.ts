import { createHash } from "node:crypto";
import { APICallError } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import {
	CodexEgressUnavailable,
	IncompleteAgentTurn,
	SafeApiModelFailure,
	SubscriptionUsageLimitReached,
} from "#/domain/api-turn-failure";
import { claudeCodeTurnRevision } from "#/domain/claude-code-route";
import { SessionItemId } from "#/domain/ids";
import {
	routeRetries,
	type TurnFailover,
	type TurnFailoverColumn,
} from "#/domain/model-failover";
import type { ModelSwitchItem, SessionItem } from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const OPENROUTER = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
	finalize: vi.fn(),
	checkpoint: vi.fn(),
	subscriptionStep: vi.fn(),
	apiStep: vi.fn(),
	preferences: vi.fn(),
	analytics: vi.fn(),
	owner: vi.fn(),
	result: vi.fn(),
	claudeStatus: vi.fn(),
	stopClaudeCode: vi.fn(),
	// Same-route retry waits; the failover tests below run without retries.
	retryDelays: [] as number[],
}));

// The project switch for Y reads the database; these turns run with it off.
vi.mock("../adapters/y-mode", () => ({ projectYMode: async () => null }));
vi.mock("#/domain/model-failover", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/domain/model-failover")>()),
	get MODEL_STEP_RETRY_DELAYS_MS() {
		return mocks.retryDelays;
	},
}));

vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: vi.fn(async () => true),
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: mocks.checkpoint,
	publishApiTurnProgress: vi.fn(async () => undefined),
	apiTurnCancelRequested: vi.fn(async () => false),
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	agentSessionMetadataForOwner: mocks.owner,
}));
vi.mock("../adapters/analytics", () => ({
	captureServerAnalytics: mocks.analytics,
}));
vi.mock("../adapters/mcp-servers", () => ({
	connectableMcpServers: async () => [],
}));
vi.mock("../adapters/plugin-installs", () => ({
	enabledPluginSkillIndex: async () => [],
	pluginSkillBody: async () => null,
}));
vi.mock("../services/api-agent-command-tools", () => ({
	completedAgentCommands: vi.fn(async () => []),
}));
vi.mock("../services/turn-commit", () => ({
	commitSessionTurn: vi.fn(async () => undefined),
}));
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: vi.fn(async () => ""),
	recordCloudProjectReport: vi.fn(async () => undefined),
}));
vi.mock("../adapters/agent-task-events", () => ({
	releaseHeldAgentTaskEvents: async () => 0,
	saveAgentTaskResultAndEvent: mocks.result,
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: vi.fn() }));
vi.mock("../adapters/server-peer-inbox", () => ({
	injectServerPeerMessages: vi.fn(),
}));
vi.mock("../adapters/api-usage-budget", () => ({ reserveApiTokens: vi.fn() }));
// Root chats are builders: each turn records a code point before it edits.
vi.mock("../services/conversation-recovery", () => ({
	ensureConversationCodePoint: vi.fn(async () => {}),
}));
vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: vi.fn(async () => null),
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: vi.fn(async () => true),
}));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: vi.fn(),
	runApiAgentStep: mocks.apiStep,
}));
vi.mock("../services/codex-subscription-agent", () => ({
	runCodexSubscriptionAgent: vi.fn(),
	runCodexSubscriptionAgentStep: mocks.subscriptionStep,
}));
vi.mock("../services/api-agent-tools", () => ({ apiAgentTools: () => ({}) }));
vi.mock("../services/api-command-scope", () => ({
	stopApiTurnCommands: vi.fn(async () => undefined),
}));
vi.mock("../services/project-secrets", () => ({
	loadAgentProjectSecrets: vi.fn(async () => ({
		envFile: "",
		redact: [],
		names: [],
	})),
	writeAgentProjectSecrets: vi.fn(async () => undefined),
}));
vi.mock("../services/api-turn-workspace", () => ({
	deferredApiTurnWorkspace: () => async () => ({
		machines: {},
		vm: "vm",
		cwd: "/repo",
	}),
}));
vi.mock("../services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
// The failover planner runs for real over these connections.
vi.mock("../adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: mocks.preferences,
}));
vi.mock("../adapters/codex-subscription", () => ({
	warmCodexSubscriptionCatalog: vi.fn(),
	codexSubscriptionCatalog: vi.fn(async () => [
		{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
	]),
}));
vi.mock("../adapters/browse-models", () => ({ browseModels: async () => [] }));
vi.mock("../adapters/claude-subscription", () => ({
	claudeSubscriptionStatus: mocks.claudeStatus,
	hasClaudeSubscription: async () => false,
}));
vi.mock("../services/claude-code-turn", () => ({
	claudeCodeBridgeToolSet: () => ({}),
	runClaudeCodeTurnStep: vi.fn(),
	stopClaudeCodeTurnRun: mocks.stopClaudeCode,
}));
vi.mock("../adapters/model-connections", () => {
	const openRouter = {
		id: "11111111-1111-4111-8111-111111111111",
		provider: "openrouter",
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		revision: "or-rev",
		models: [
			{
				id: "openai/gpt-6.1-sol",
				label: "openai/gpt-6.1-sol",
				toolStreamingVerified: true,
			},
		],
	};
	return {
		listModelConnections: vi.fn(async () => [openRouter]),
		loadModelConnection: vi.fn(async () => ({
			...openRouter,
			sealedCredential: "sealed",
		})),
	};
});

const usage = (inputTokens: number) => ({
	inputTokens,
	outputTokens: 10,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
});

const step = (index: number) => ({
	index,
	signal: new AbortController().signal,
});

function codexTurn(): ApiTurn {
	return {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: null,
		connection_revision: subscriptionTurnRevision("high", false),
		model_id: "gpt-6.1-sol",
		state: "running",
		messages: [{ role: "user", content: "Fix the failing test." }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Fix the failing test.",
			},
		],
		lease_id: "lease",
		failover: null,
	};
}

/** The turn as the next durable step loads it: its last checkpoint. */
function afterCheckpoint(turn: ApiTurn): ApiTurn {
	const [, messages, items, failover] = mocks.checkpoint.mock.calls.at(-1) as [
		ApiTurn,
		ApiTurn["messages"],
		SessionItem[],
		TurnFailoverColumn | undefined,
	];
	return { ...turn, messages, items, failover: failover ?? turn.failover };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.retryDelays = [];
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.checkpoint.mockResolvedValue(undefined);
	mocks.analytics.mockResolvedValue(undefined);
	mocks.result.mockResolvedValue(null);
	mocks.claudeStatus.mockResolvedValue({ status: "disconnected" });
	mocks.stopClaudeCode.mockResolvedValue(undefined);
	mocks.preferences.mockResolvedValue({
		enabled: true,
		askBeforePaid: false,
		connectionOrder: [],
	});
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "codex",
		parentSessionId: null,
		taskAccess: null,
	});
});

it("continues the same turn on the fallback after a provider 503, with a notice and truthful usage", async () => {
	// Step 1: Codex reads a file and asks for another step.
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		await input.onEvent({ type: "usage", usage: usage(100) });
		const messages = [
			...input.messages,
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "",
						providerOptions: {
							openai: { reasoningEncryptedContent: "encrypted" },
						},
					},
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "read_file",
						input: { path: "a.test.ts" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_file",
						output: { type: "text", value: "body" },
					},
				],
			},
		];
		await input.onStep(messages);
		return { messages, outcome: "continue" };
	});
	let turn = codexTurn();
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);

	// Step 2: Codex is down. The step's partial text is cut off by the failure.
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		await input.onEvent({ type: "text-delta", id: "t1", text: "Now I" });
		input.onAttemptFailed?.({
			committed: input.messages,
			droppedStepSaved: false,
			uncommittedIds: ["t1"],
		});
		throw new SafeApiModelFailure(
			new APICallError({
				message: "Service Unavailable",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			}),
		);
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
		"continue",
	);
	expect(mocks.finalize).not.toHaveBeenCalled();
	turn = afterCheckpoint(turn);
	const failover = turn.failover as TurnFailover;
	expect(failover.route).toEqual({
		connectionId: OPENROUTER,
		connectionRevision: "or-rev",
		modelId: "openai/gpt-6.1-sol",
		// The user's reasoning level carries over where the fallback supports it.
		settings: { reasoning: "high" },
	});
	const notice = turn.items.find(
		(item): item is ModelSwitchItem => item.kind === "modelSwitch",
	);
	expect(notice).toMatchObject({
		state: "switched",
		reason: "outage",
		message:
			"Codex is down right now, so this chat continued on GPT-6.1 Sol via OpenRouter.",
		usageBefore: usage(100),
	});
	expect(turn.items.some((item) => item.kind === "agentMessage")).toBe(false);
	// Codex's encrypted reasoning never reaches OpenRouter; the tool work does.
	expect(JSON.stringify(turn.messages)).not.toContain("encrypted");
	expect(turn.messages.at(-1)).toMatchObject({ role: "user" });
	expect(String(turn.messages.at(-1)?.content)).toContain(
		"Runtime model switch",
	);
	expect(JSON.stringify(turn.messages)).toContain("call_1");
	expect(turn.model_id).toBe("gpt-6.1-sol");
	expect(mocks.analytics).toHaveBeenCalledWith(
		"owner",
		"model_failover",
		expect.objectContaining({
			reason: "outage",
			outcome: "switched",
			same_model: true,
			to_paid: true,
		}),
		expect.anything(),
	);

	// Step 3 runs on OpenRouter with the full history and finishes.
	mocks.apiStep.mockImplementationOnce(async (input) => {
		expect(input).toMatchObject({
			connectionId: OPENROUTER,
			connectionRevision: "or-rev",
			modelId: "openai/gpt-6.1-sol",
		});
		expect(input.messages).toEqual(turn.messages);
		await input.onEvent({ type: "usage", usage: usage(50) });
		await input.onEvent({ type: "text-delta", id: "r", text: "Fixed." });
		input.onModelMetric?.({});
		return { messages: input.messages, outcome: "completed" };
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(3))).toBe(
		"completed",
	);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(2);
	const finalItems = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	const user = finalItems.find((item) => item.kind === "userMessage");
	// Codex served 100 input tokens before the switch; OpenRouter 50 after.
	expect(user?.kind === "userMessage" && user.apiUsage?.inputTokens).toBe(150);
	expect(finalItems.find((item) => item.kind === "modelSwitch")).toMatchObject({
		usageBefore: usage(100),
	});
	expect(mocks.analytics).toHaveBeenCalledWith(
		"owner",
		"harness_model_completed",
		expect.objectContaining({
			model_key: createHash("sha256")
				.update("openai/gpt-6.1-sol")
				.digest("hex"),
		}),
		expect.anything(),
	);
});

it("never fails over a caller problem", async () => {
	mocks.subscriptionStep.mockRejectedValueOnce(
		new SafeApiModelFailure(
			new APICallError({
				message: "context_length_exceeded",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 400,
				data: { error: { code: "context_length_exceeded" } },
			}),
		),
	);
	expect(await runApiTurn({} as WorkspaceMachines, codexTurn(), step(1))).toBe(
		"failed",
	);
	expect(mocks.apiStep).not.toHaveBeenCalled();
	expect(mocks.checkpoint).not.toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		expect.anything(),
		expect.anything(),
	);
});

it("asks before moving onto a paid key when the user wants that", async () => {
	mocks.preferences.mockResolvedValue({
		enabled: true,
		askBeforePaid: true,
		connectionOrder: [],
	});
	mocks.subscriptionStep.mockRejectedValueOnce(
		new SafeApiModelFailure(
			new APICallError({
				message: "Service Unavailable",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			}),
		),
	);
	expect(await runApiTurn({} as WorkspaceMachines, codexTurn(), step(1))).toBe(
		"failed",
	);
	expect(mocks.apiStep).not.toHaveBeenCalled();
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.at(-1)).toMatchObject({
		kind: "modelSwitch",
		state: "awaitingApproval",
		to: {
			model: "GPT-6.1 Sol",
			connection: "OpenRouter",
			key: `${OPENROUTER}|openai/gpt-6.1-sol`,
		},
	});
	expect(items.some((item) => item.kind === "error")).toBe(false);
});

it("lists what it tried when the fallback fails too, and never loops back", async () => {
	mocks.subscriptionStep.mockRejectedValueOnce(
		new SafeApiModelFailure(
			new APICallError({
				message: "Service Unavailable",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			}),
		),
	);
	let turn = codexTurn();
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	mocks.apiStep.mockRejectedValueOnce(new IncompleteAgentTurn("error"));
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
		"failed",
	);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(1);
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.at(-1)).toMatchObject({
		kind: "error",
		// Leads with why Codex stopped, then why the fallback failed too.
		message: expect.stringContaining(
			"Codex is down right now. Switching to OpenRouter didn't work either:",
		),
	});
});

it("keeps the local worker's turn running on the fallback in the same call", async () => {
	mocks.subscriptionStep.mockReset();
	const local = vi.mocked(
		(await import("../services/codex-subscription-agent"))
			.runCodexSubscriptionAgent,
	);
	local.mockRejectedValueOnce(
		new SafeApiModelFailure(
			new APICallError({
				message: "Overloaded",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 529,
				isRetryable: true,
			}),
		),
	);
	const api = vi.mocked(
		(await import("../services/api-agent-runtime")).runApiAgent,
	);
	api.mockImplementationOnce(async (input) => {
		expect(input.connectionId).toBe(OPENROUTER);
		await input.onEvent({ type: "text-delta", id: "r", text: "Done." });
		return input.messages;
	});
	expect(await runApiTurn({} as WorkspaceMachines, codexTurn())).toBe(
		"completed",
	);
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.find((item) => item.kind === "modelSwitch")).toMatchObject({
		reason: "overloaded",
	});
});

const codexRoute = {
	connectionId: null,
	connectionRevision: subscriptionTurnRevision("high", false),
	modelId: "gpt-6.1-sol",
};

/** Codex streams some text, then the stream ends in error. */
function midStreamFailure(error: unknown = new IncompleteAgentTurn("error")) {
	return async (input: {
		messages: ApiTurn["messages"];
		onEvent: (event: unknown) => Promise<void>;
		onAttemptFailed?: (state: unknown) => void;
	}) => {
		await input.onEvent({ type: "text-delta", id: "t1", text: "Let me" });
		input.onAttemptFailed?.({
			committed: input.messages,
			droppedStepSaved: false,
			uncommittedIds: ["t1"],
		});
		throw error;
	};
}

function switchItem(turn: ApiTurn) {
	return turn.items.find(
		(item): item is ModelSwitchItem => item.kind === "modelSwitch",
	);
}

it("retries a transient mid-stream failure on the same route before any switch", async () => {
	mocks.retryDelays = [0, 0];
	mocks.subscriptionStep.mockImplementationOnce(midStreamFailure());
	let turn = codexTurn();
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	expect(routeRetries(turn.failover, codexRoute)).toBe(1);
	// Still the user's route: no switch, no notice, the cut-off text retracted.
	expect(switchItem(turn)).toBeUndefined();
	expect(turn.items.some((item) => item.kind === "agentMessage")).toBe(false);
	expect(turn.messages).toEqual(codexTurn().messages);

	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		expect(input.modelId).toBe("gpt-6.1-sol");
		expect(input.messages).toEqual(codexTurn().messages);
		await input.onEvent({ type: "text-delta", id: "r", text: "Fixed." });
		return { messages: input.messages, outcome: "completed" };
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
		"completed",
	);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(2);
	expect(mocks.apiStep).not.toHaveBeenCalled();
	// The step that succeeded cleared the count for later failures.
	expect(routeRetries(afterCheckpoint(turn).failover, codexRoute)).toBe(0);
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.some((item) => item.kind === "modelSwitch")).toBe(false);
	expect(mocks.analytics).not.toHaveBeenCalledWith(
		"owner",
		"model_failover",
		expect.anything(),
		expect.anything(),
	);
});

it("fails over after the third transient failure in a row, saying why", async () => {
	mocks.retryDelays = [0, 0];
	let turn = codexTurn();
	for (const index of [1, 2]) {
		mocks.subscriptionStep.mockImplementationOnce(midStreamFailure());
		expect(await runApiTurn({} as WorkspaceMachines, turn, step(index))).toBe(
			"continue",
		);
		turn = afterCheckpoint(turn);
		expect(routeRetries(turn.failover, codexRoute)).toBe(index);
		expect(switchItem(turn)).toBeUndefined();
	}
	mocks.subscriptionStep.mockImplementationOnce(
		midStreamFailure(
			new SafeApiModelFailure(
				new APICallError({
					message: "Service Unavailable Bearer secret-token",
					url: "https://chatgpt.com/backend-api/codex/responses",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				}),
			),
		),
	);
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(3))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(3);
	expect((turn.failover as TurnFailover).route.connectionId).toBe(OPENROUTER);
	const notice = switchItem(turn);
	expect(notice).toMatchObject({ state: "switched", reason: "outage" });
	expect(notice?.cause).toContain("503: Service Unavailable");
	expect(notice?.cause).not.toContain("secret-token");
	expect(notice?.cause?.length).toBeLessThanOrEqual(300);
});

it.each([
	["a usage limit", new SubscriptionUsageLimitReached(null), "usage-limit"],
	[
		"a blocked Codex egress",
		new CodexEgressUnavailable([{ path: "direct", reason: "403" }]),
		"outage",
	],
])("fails over at once on %s, without a retry", async (_, error, reason) => {
	mocks.retryDelays = [0, 0];
	mocks.subscriptionStep.mockRejectedValueOnce(error);
	let turn = codexTurn();
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(1);
	expect((turn.failover as TurnFailover).route.connectionId).toBe(OPENROUTER);
	expect(switchItem(turn)).toMatchObject({ reason });
});

it("records the plan's reset time on a usage-limit switch", async () => {
	const resetsAt = new Date("2026-10-26T20:00:00Z");
	mocks.subscriptionStep.mockRejectedValueOnce(
		new SubscriptionUsageLimitReached(resetsAt),
	);
	let turn = codexTurn();
	await runApiTurn({} as WorkspaceMachines, turn, step(1));
	turn = afterCheckpoint(turn);
	expect(switchItem(turn)).toMatchObject({
		reason: "usage-limit",
		resetsAt: resetsAt.getTime(),
	});
});

it("keeps the retry count across an executor restart", async () => {
	mocks.retryDelays = [0, 0];
	mocks.subscriptionStep.mockImplementationOnce(midStreamFailure());
	let turn = codexTurn();
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	// The retried step is re-run after its executor restarted mid-step.
	mocks.subscriptionStep.mockImplementationOnce(midStreamFailure());
	expect(
		await runApiTurn({} as WorkspaceMachines, turn, {
			...step(2),
			resumed: true,
		}),
	).toBe("continue");
	turn = afterCheckpoint(turn);
	expect(routeRetries(turn.failover, codexRoute)).toBe(2);
	mocks.subscriptionStep.mockImplementationOnce(midStreamFailure());
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(3))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	expect((turn.failover as TurnFailover).route.connectionId).toBe(OPENROUTER);
});

it("retries the local worker's turn in the same call", async () => {
	mocks.retryDelays = [0, 0];
	const local = vi.mocked(
		(await import("../services/codex-subscription-agent"))
			.runCodexSubscriptionAgent,
	);
	local.mockReset();
	local.mockRejectedValueOnce(new IncompleteAgentTurn("error"));
	local.mockImplementationOnce(async (input) => {
		await input.onEvent({ type: "text-delta", id: "r", text: "Done." });
		return input.messages;
	});
	expect(await runApiTurn({} as WorkspaceMachines, codexTurn())).toBe(
		"completed",
	);
	expect(local).toHaveBeenCalledTimes(2);
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.some((item) => item.kind === "modelSwitch")).toBe(false);
});

it("moves past a fallback that is out of credit to the next connection, never back", async () => {
	const OPENAI_KEY = "22222222-2222-4222-8222-222222222222";
	const connections = vi.mocked(await import("../adapters/model-connections"));
	const [openRouter] = await connections.listModelConnections("owner");
	const openAiKey = {
		...openRouter,
		id: OPENAI_KEY,
		provider: "openai",
		label: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		revision: "oa-rev",
		models: [
			{ id: "gpt-6.1-sol", label: "gpt-6.1-sol", toolStreamingVerified: true },
		],
	} as typeof openRouter;
	connections.listModelConnections.mockResolvedValue([openRouter, openAiKey]);
	connections.loadModelConnection.mockImplementation(async (_user, id) =>
		id === OPENAI_KEY
			? { ...openAiKey, sealedCredential: "sealed" }
			: ({ ...openRouter, sealedCredential: "sealed" } as never),
	);
	const outOfCredit = () =>
		new SafeApiModelFailure(
			new APICallError({
				message: "Payment Required",
				url: "https://api.openai.com/v1/responses",
				requestBodyValues: {},
				statusCode: 402,
				responseBody:
					'{"error":{"message":"You requested up to 64000 tokens, but can only afford 1253."}}',
			}),
		);
	try {
		// Codex is down: the first fallback is the same model on the OpenAI key.
		mocks.subscriptionStep.mockRejectedValueOnce(
			new SafeApiModelFailure(
				new APICallError({
					message: "Service Unavailable",
					url: "https://chatgpt.com/backend-api/codex/responses",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				}),
			),
		);
		let turn = codexTurn();
		expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
			"continue",
		);
		turn = afterCheckpoint(turn);
		expect((turn.failover as TurnFailover).route.connectionId).toBe(OPENAI_KEY);
		// That key is out of credit: the turn continues on OpenRouter.
		mocks.apiStep.mockRejectedValueOnce(outOfCredit());
		expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
			"continue",
		);
		turn = afterCheckpoint(turn);
		const failover = turn.failover as TurnFailover;
		expect(failover).toMatchObject({
			route: { connectionId: OPENROUTER },
			switches: 2,
			fallbackHops: 1,
			excluded: [OPENAI_KEY],
		});
		const notes = turn.items.filter(
			(item): item is ModelSwitchItem => item.kind === "modelSwitch",
		);
		expect(notes.map((note) => note.message)).toEqual([
			"Codex is down right now, so this chat continued on GPT-6.1 Sol via OpenAI.",
			"OpenAI is out of credit, so this chat continued on GPT-6.1 Sol via OpenRouter.",
		]);
		expect(mocks.analytics).toHaveBeenCalledWith(
			"owner",
			"model_failover",
			expect.objectContaining({ reason: "out-of-credit", outcome: "switched" }),
			expect.anything(),
		);
		// OpenRouter is out of credit too: nothing is left, and the turn says why.
		mocks.apiStep.mockRejectedValueOnce(outOfCredit());
		expect(await runApiTurn({} as WorkspaceMachines, turn, step(3))).toBe(
			"failed",
		);
		const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
		expect(items.at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining(
				"Codex is down right now. Switching to OpenAI and OpenRouter didn't work either: Your API provider account is out of credit.",
			),
		});
		expect(mocks.subscriptionStep).toHaveBeenCalledTimes(1);
	} finally {
		connections.listModelConnections.mockResolvedValue([openRouter]);
		connections.loadModelConnection.mockImplementation(
			async () =>
				({
					...openRouter,
					sealedCredential: "sealed",
				}) as never,
		);
	}
});

it("never moves a turn off the route the user chose for its own spent credit", async () => {
	mocks.apiStep.mockRejectedValueOnce(
		new SafeApiModelFailure(
			new APICallError({
				message: "Payment Required",
				url: "https://openrouter.ai/api/v1/chat/completions",
				requestBodyValues: {},
				statusCode: 402,
			}),
		),
	);
	const turn: ApiTurn = {
		...codexTurn(),
		connection_id: OPENROUTER,
		connection_revision: "or-rev",
		model_id: "openai/gpt-6.1-sol",
	};
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"failed",
	);
	expect(mocks.subscriptionStep).not.toHaveBeenCalled();
	const items = mocks.finalize.mock.calls.at(-1)?.[2] as SessionItem[];
	expect(items.some((item) => item.kind === "modelSwitch")).toBe(false);
	expect(items.at(-1)).toMatchObject({
		kind: "error",
		message: expect.stringContaining("out of credit"),
	});
});

it("moves a refused Claude Code turn to the ChatGPT plan before a paid key, and stops the CLI", async () => {
	process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
	const connections = vi.mocked(await import("../adapters/model-connections"));
	const [openRouter] = await connections.listModelConnections("owner");
	// OpenRouter also serves the very model the user chose.
	connections.listModelConnections.mockResolvedValue([
		{
			...openRouter,
			models: [
				{
					id: "anthropic/claude-opus-5.5",
					label: "anthropic/claude-opus-5.5",
					toolStreamingVerified: true,
				},
				...openRouter.models,
			],
		} as typeof openRouter,
	]);
	try {
		mocks.claudeStatus.mockResolvedValue({ status: "refused" });
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			parentSessionId: null,
			taskAccess: null,
			providerRef: "vm-1",
		});
		const turn: ApiTurn = {
			...codexTurn(),
			connection_revision: claudeCodeTurnRevision(),
			model_id: "claude-opus-5-5",
		};
		expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
			"continue",
		);
		const next = afterCheckpoint(turn);
		const failover = next.failover as TurnFailover;
		// The ChatGPT plan (prepaid) before Claude Opus on the OpenRouter key.
		expect(failover.route).toMatchObject({
			connectionId: null,
			modelId: "gpt-6.1-sol",
		});
		expect(failover.excluded).toEqual(["claude-code"]);
		expect(
			next.items.find((item) => item.kind === "modelSwitch"),
		).toMatchObject({
			reason: "signed-out",
			message:
				"Anthropic refused your Claude token, so this chat continued on GPT-6.1-Sol via Codex.",
		});
		expect(mocks.stopClaudeCode).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: "turn", vm: "vm-1" }),
		);
		// The user's choice stays the turn's own route.
		expect(next.model_id).toBe("claude-opus-5-5");
	} finally {
		delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
		connections.listModelConnections.mockResolvedValue([openRouter]);
	}
});
