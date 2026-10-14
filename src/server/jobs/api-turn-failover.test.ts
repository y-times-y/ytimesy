import { createHash } from "node:crypto";
import { APICallError } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import {
	IncompleteAgentTurn,
	SafeApiModelFailure,
} from "#/domain/api-turn-failure";
import { SessionItemId } from "#/domain/ids";
import type { TurnFailover } from "#/domain/model-failover";
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
	enabledPluginComponents: async () => [],
}));
vi.mock("../services/api-agent-command-tools", () => ({
	completedAgentCommands: vi.fn(async () => []),
}));
vi.mock("../services/turn-commit", () => ({
	commitCompletedSessionTurn: vi.fn(async () => undefined),
}));
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: vi.fn(async () => ""),
	recordCloudProjectReport: vi.fn(async () => undefined),
}));
vi.mock("../adapters/agent-task-events", () => ({
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
	loadAgentProjectSecrets: vi.fn(async () => ({ envFile: "", redact: [] })),
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
	codexSubscriptionCatalog: vi.fn(async () => [
		{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
	]),
}));
vi.mock("../adapters/browse-models", () => ({ browseModels: async () => [] }));
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
		TurnFailover | undefined,
	];
	return { ...turn, messages, items, failover: failover ?? turn.failover };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.checkpoint.mockResolvedValue(undefined);
	mocks.analytics.mockResolvedValue(undefined);
	mocks.result.mockResolvedValue(null);
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
			"Codex is unavailable (outage); continued on GPT-6.1 Sol via OpenRouter.",
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
		message: expect.stringContaining(
			"Automatic failover tried: GPT-6.1-Sol via Codex, GPT-6.1 Sol via OpenRouter.",
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
