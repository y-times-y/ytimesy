import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { TurnFailover } from "#/domain/model-failover";
import type { ModelSwitchItem, SessionItem } from "#/domain/session-item";
import { newSidekickState, type SidekickState } from "#/domain/sidekick";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { ModelSwitchAtCompaction } from "../services/model-agent-loop";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	finalize: vi.fn(),
	checkpoint: vi.fn(),
	subscriptionStep: vi.fn(),
	apiStep: vi.fn(),
	preferences: vi.fn(),
	analytics: vi.fn(),
	owner: vi.fn(),
	result: vi.fn(),
	saveSidekick: vi.fn(),
}));

// The sidekick's row: what the turn reloads at each attempt.
const row = vi.hoisted(() => ({
	current: null as null | Record<string, unknown>,
}));
// The project switch for Y reads the database; these turns run with it off.
vi.mock("../adapters/y-mode", () => ({ projectYMode: async () => null }));
vi.mock("../adapters/subagents", () => ({
	subagentAncestors: vi.fn(async () => [{ id: "root" }]),
	updateSidekickState: vi.fn(
		async (
			_id: string,
			mutate: (state: SidekickState) => SidekickState | null,
			model?: { listedModelId: string; harness: string },
		) => {
			const session = row.current as {
				agentBudget: { sidekick: SidekickState };
			};
			const next = mutate(session.agentBudget.sidekick);
			if (!next) return null;
			row.current = {
				...session,
				...(model ?? {}),
				agentBudget: { ...session.agentBudget, sidekick: next },
			};
			mocks.saveSidekick(next, model);
			return next;
		},
	),
}));
vi.mock("../adapters/dev-eval-users", () => ({
	devEvalUsersEnabled: () => true,
	isDevEvalUser: async () => false,
	harnessVariantForUser: async () => ({
		...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
		lead: "fusion",
		subagents: "on",
		roleModels: {
			writer: { model: "codex:gpt-6-luna" },
			writerEscalation: { model: "codex:gpt-6.1-sol" },
		},
	}),
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
	COMMAND_SCOPES_DIRECTORY: "/tmp/ytimesy-api-command-scopes",
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
		{ id: "gpt-6-luna", label: "GPT-6 Luna" },
		{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
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

const step = (index: number) => ({
	index,
	signal: new AbortController().signal,
});

function sidekickTurn(id: string): ApiTurn {
	return {
		id,
		session_id: "session",
		user_id: "owner",
		connection_id: null,
		connection_revision: subscriptionTurnRevision(undefined, false),
		model_id: "gpt-6-luna",
		state: "running",
		messages: [
			{ role: "user", content: "Round 1 brief" },
			{ role: "assistant", content: "Round 1 report" },
			{ role: "user", content: "Round 2/6 from your lead. Fix it." },
		],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Round 2/6 from your lead. Fix it.",
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
	const state = {
		...newSidekickState({ tokens: 1_000_000 }, "2026-10-20T12:00:00.000Z"),
		round: 2,
		pendingSwitch: {
			to: "codex:gpt-6.1-sol",
			reason: "it repeats make test",
			round: 1,
			at: "2026-10-20T12:00:00.000Z",
		},
	};
	row.current = {
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "codex",
		listedModelId: "gpt-6-luna",
		parentSessionId: "root",
		taskAccess: "read_write",
		agentRole: "writer",
		agentBudget: {
			steps: 100,
			minutes: 30,
			tokens: 1_000_000,
			sidekick: state,
		},
	};
	mocks.owner.mockImplementation(async () => row.current);
});

it("continues a sidekick's turn on the escalation route after its compaction, and does not compact for it again", async () => {
	let turn = sidekickTurn("turn-switched");
	const compacted = [
		{
			role: "assistant" as const,
			content: "Summary of earlier conversation: …",
		},
		{ role: "user" as const, content: "Round 2/6 from your lead. Fix it." },
	];
	// Step 1 on gpt-6-luna: a pending switch compacts first, then ends the run.
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		expect(input).toMatchObject({ modelId: "gpt-6-luna", compactFirst: true });
		await input.onStep(compacted);
		throw new ModelSwitchAtCompaction(
			{
				spec: "codex:gpt-6.1-sol",
				reason: "it repeats make test",
				trigger: "pending",
			},
			true,
		);
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	expect(mocks.finalize).not.toHaveBeenCalled();
	turn = afterCheckpoint(turn);
	expect((turn.failover as TurnFailover).route).toEqual({
		connectionId: null,
		connectionRevision: subscriptionTurnRevision(undefined, false),
		modelId: "gpt-6.1-sol",
	});
	expect(
		turn.items.find(
			(item): item is ModelSwitchItem => item.kind === "modelSwitch",
		),
	).toMatchObject({
		state: "switched",
		reason: "sidekick-escalation",
		to: { model: "GPT-6.1 Sol" },
	});
	expect(JSON.stringify(turn.messages)).toContain(
		"Summary of earlier conversation",
	);
	expect(String(turn.messages.at(-1)?.content)).toContain(
		"you now run on gpt-6.1-sol",
	);
	// The session moved with the state, in one write.
	expect(mocks.saveSidekick).toHaveBeenCalledWith(
		expect.objectContaining({
			model: "gpt-6.1-sol",
			switches: [expect.objectContaining({ trigger: "pending" })],
		}),
		{ listedModelId: "gpt-6.1-sol", harness: "codex" },
	);
	expect(row.current?.listedModelId).toBe("gpt-6.1-sol");

	// Step 2 reloads the session: on gpt-6.1-sol, nothing pending, no compaction first.
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		expect(input).toMatchObject({
			modelId: "gpt-6.1-sol",
			compactFirst: false,
		});
		expect(input.messages).toEqual(turn.messages);
		return { messages: input.messages, outcome: "continue" };
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
		"continue",
	);
	expect(mocks.subscriptionStep).toHaveBeenCalledTimes(2);
});

it("keeps the route and stops switching in a turn whose switch cannot complete", async () => {
	mocks.saveSidekick.mockImplementation(() => {
		throw new Error("database unavailable");
	});
	let turn = sidekickTurn("turn-dropped");
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		expect(input.compactFirst).toBe(true);
		throw new ModelSwitchAtCompaction(
			{ spec: "codex:gpt-6.1-sol", reason: "stuck", trigger: "pending" },
			true,
		);
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(1))).toBe(
		"continue",
	);
	turn = afterCheckpoint(turn);
	expect(turn.failover).toBeNull();
	expect(turn.items.some((item) => item.kind === "modelSwitch")).toBe(false);
	// The state still holds the pending switch, but this turn compacts for it no more.
	mocks.subscriptionStep.mockImplementationOnce(async (input) => {
		expect(input).toMatchObject({ modelId: "gpt-6-luna", compactFirst: false });
		return { messages: input.messages, outcome: "continue" };
	});
	expect(await runApiTurn({} as WorkspaceMachines, turn, step(2))).toBe(
		"continue",
	);
});
