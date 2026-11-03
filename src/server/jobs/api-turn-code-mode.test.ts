import { beforeEach, expect, it, vi } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	PRODUCT_HARNESS_VARIANT,
} from "#/domain/harness-variant";
import { SessionItemId } from "#/domain/ids";
import { codeModeInstructions } from "#/domain/lean-tool-instructions";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { planTool } from "../services/plan-tool";
import { webFetchTool } from "../services/web-fetch-tool";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	renew: vi.fn(),
	finalize: vi.fn(),
	stop: vi.fn(),
	runtime: vi.fn(),
	stepRuntime: vi.fn(),
	result: vi.fn(),
	enqueue: vi.fn(),
	owner: vi.fn(),
	knowledge: vi.fn(),
	report: vi.fn(),
	subscriptionRuntime: vi.fn(),
	auth: vi.fn(),
	commit: vi.fn(),
	commandCompletions: vi.fn(),
	progress: vi.fn(),
	checkpoint: vi.fn(),
	promptSubmit: vi.fn(),
	cancelRequested: vi.fn(),
	variant: vi.fn(),
}));
// Observes the real lifecycle hooks' UserPromptSubmit without a repository config.
vi.mock("../services/harness-lifecycle-hooks", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../services/harness-lifecycle-hooks")
		>();
	return {
		...actual,
		harnessLifecycleHooks: (
			input: Parameters<typeof actual.harnessLifecycleHooks>[0],
		) => {
			const hooks = actual.harnessLifecycleHooks(input);
			return {
				...hooks,
				userPromptSubmit: async (prompt: string) =>
					(await mocks.promptSubmit(prompt)) ?? hooks.userPromptSubmit(prompt),
			};
		},
	};
});
vi.mock("../adapters/mcp-servers", () => ({
	connectableMcpServers: async () => [],
}));
vi.mock("../adapters/plugin-installs", () => ({
	enabledPluginComponents: async () => [],
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
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: mocks.knowledge,
	recordCloudProjectReport: mocks.report,
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: mocks.renew,
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: mocks.checkpoint,
	publishApiTurnProgress: mocks.progress,
	apiTurnCancelRequested: mocks.cancelRequested,
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	agentSessionMetadataForOwner: mocks.owner,
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.progress.mockReset().mockResolvedValue(undefined);
	mocks.checkpoint.mockReset().mockResolvedValue(undefined);
	vi.mocked(coordinateConversationTurn).mockReset().mockResolvedValue(true);
	mocks.knowledge.mockResolvedValue(
		"## Existing capabilities\nBranch selection is implemented in branch.ts.",
	);
	mocks.report.mockResolvedValue(undefined);
	mocks.auth.mockResolvedValue(true);
	mocks.commit.mockReset().mockResolvedValue(undefined);
	mocks.stop.mockReset().mockResolvedValue(undefined);
	mocks.commandCompletions.mockReset().mockResolvedValue([]);
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		taskAccess: "read_write",
	});
	mocks.renew.mockReset().mockResolvedValue(true);
	mocks.promptSubmit.mockReset().mockResolvedValue(undefined);
	mocks.cancelRequested.mockReset().mockResolvedValue(false);
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.result.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
});

vi.mock("../adapters/dev-eval-users", () => ({
	devEvalUsersEnabled: () => true,
	harnessVariantForUser: mocks.variant,
	isDevEvalUser: async () => false,
}));
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: vi.fn(async () => ({ revision: "revision" })),
}));
vi.mock("../adapters/agent-task-events", () => ({
	releaseHeldAgentTaskEvents: async () => 0,
	saveAgentTaskResultAndEvent: mocks.result,
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
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
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: mocks.runtime,
	runApiAgentStep: mocks.stepRuntime,
}));
vi.mock("../services/codex-subscription-agent", () => ({
	runCodexSubscriptionAgent: mocks.subscriptionRuntime,
	runCodexSubscriptionAgentStep: vi.fn(),
}));
vi.mock("../services/api-command-scope", () => ({
	stopApiTurnCommands: mocks.stop,
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

// Hard-set round 1: the codeMode=on arm never called run_code. This builds a
// Codex-subscription GPT builder turn for an eval user with codeMode=on on the
// real lean surface and checks what the model is offered.
const subscriptionTurn = {
	id: "turn",
	session_id: "session",
	user_id: "owner",
	connection_id: null,
	connection_revision: subscriptionTurnRevision("medium"),
	model_id: "gpt-6.1-sol",
	state: "running",
	messages: [{ role: "user", content: "Fix branches" }],
	items: [
		{ kind: "userMessage", id: SessionItemId("user"), text: "Fix branches" },
	],
	lease_id: "lease",
} as ApiTurn;

async function offered(variant: Partial<typeof DEFAULT_HARNESS_VARIANT>) {
	mocks.variant.mockResolvedValue({ ...DEFAULT_HARNESS_VARIANT, ...variant });
	mocks.promptSubmit.mockResolvedValue({ block: false });
	let seen:
		| {
				tools: Record<string, { description?: string }>;
				instructions: string;
				toolOrder?: () => readonly string[];
		  }
		| undefined;
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		seen = input;
		return [];
	});
	// The model returns nothing, so the turn ends incomplete; only its input matters.
	await runApiTurn({} as WorkspaceMachines, subscriptionTurn);
	if (!seen) throw new Error("The model was not called.");
	return seen;
}

it("offers and describes run_code on the lean surface when codeMode=on", async () => {
	const input = await offered({ codeMode: "on" });
	expect(Object.keys(input.tools)).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit", "run_code"]),
	);
	expect(input.tools.run_code.description).toContain("tools.bash(args)");
	expect(input.instructions).toContain("run_code runs one JavaScript program");
});

it("offers run_code and the agent tool side by side when subagents are on", async () => {
	const input = await offered({ codeMode: "on", subagents: "on" });
	expect(Object.keys(input.tools)).toContain("run_code");
	// agent is an ordinary visible tool in every code mode; only code mode
	// primary defers anything (MCP search/call), so nothing is listed here.
	// Nothing is deferred here, so the tool set is sent as it is.
	expect(input.toolOrder).toBeUndefined();
	expect(Object.keys(input.tools)).toContain("agent");
	expect(input.instructions).toContain("run_code runs one JavaScript program");
	expect(input.instructions).not.toContain("searchTools");
});

it("offers no run_code when codeMode is off or the surface is not lean", async () => {
	for (const variant of [
		{ codeMode: "off" },
		{ codeMode: "on", toolSurface: "current" },
	] as const) {
		const input = await offered(variant);
		expect(Object.keys(input.tools)).not.toContain("run_code");
		expect(input.instructions).not.toContain("run_code");
	}
});

// The plan tool (plan=on, the product's default): the root builder gets the
// benchmark bridge's update_plan as it is, and each update is the chat's checklist.
const bridgePlanTool = planTool({ now: Date.now, onUpdate: () => {} })
	.update_plan as { description?: string };

it("offers the product's root builder the bridge's update_plan, byte for byte", async () => {
	const input = await offered(PRODUCT_HARNESS_VARIANT);
	expect(input.tools.update_plan?.description).toBe(bridgePlanTool.description);
	expect(Object.keys(input.tools)).toContain("agent");
	for (const variant of [{}, { plan: "off" }] as const)
		expect(Object.keys((await offered(variant)).tools)).not.toContain(
			"update_plan",
		);
});

it("lets run_code programs send update_plan, as its description says", async () => {
	const input = await offered({ codeMode: "on", plan: "on" });
	expect(input.tools.run_code.description).toContain("tools.update_plan(args)");
});

it("gives subagents no plan tool", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		taskAccess: "read_write",
		parentSessionId: "parent",
		agentRole: "builder",
	});
	const input = await offered({ plan: "on", subagents: "on" });
	expect(Object.keys(input.tools)).not.toContain("update_plan");
});

it("saves each accepted plan update as the turn's one checklist item", async () => {
	mocks.variant.mockResolvedValue({ ...DEFAULT_HARNESS_VARIANT, plan: "on" });
	mocks.promptSubmit.mockResolvedValue({ block: false });
	const replies: unknown[] = [];
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		const send = (plan: { step: string; status: string }[]) =>
			input.tools.update_plan.execute(
				{ plan },
				{ toolCallId: `call-${replies.length}`, messages: [] },
			);
		replies.push(
			await send([
				{ step: "Read the code", status: "in_progress" },
				{ step: "Fix branches", status: "pending" },
			]),
		);
		// Two steps in progress: refused, and the checklist keeps its last state.
		replies.push(
			await send([
				{ step: "Read the code", status: "in_progress" },
				{ step: "Fix branches", status: "in_progress" },
			]),
		);
		replies.push(
			await send([
				{ step: "Read the code", status: "completed" },
				{ step: "Fix branches", status: "in_progress" },
			]),
		);
		return [];
	});
	await runApiTurn({} as WorkspaceMachines, subscriptionTurn);
	expect(replies).toEqual([
		"Plan updated: 0 completed, 1 in progress, 1 pending.",
		"Plan not updated: 2 steps are in_progress; keep at most one.",
		"Plan updated: 1 completed, 1 in progress, 0 pending.",
	]);
	const saved = mocks.progress.mock.calls.at(-1)?.[1] as SessionItem[];
	expect(saved.filter((item) => item.kind === "plan")).toEqual([
		{
			kind: "plan",
			id: "turn:plan",
			text: "",
			todos: [
				{ text: "Read the code", status: "completed" },
				{ text: "Fix branches", status: "in_progress" },
			],
		},
	]);
});

// The product's variant runs the benchmark harness's codeMode=on and fetch=on.
it("gives product turns run_code beside the normal tools, with the bridge's text", async () => {
	const input = await offered(PRODUCT_HARNESS_VARIANT);
	expect(Object.keys(input.tools)).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit", "run_code"]),
	);
	// codeMode=on, not primary: tools are direct and nothing is deferred.
	expect(input.toolOrder).toBeUndefined();
	expect(Object.keys(input.tools)[0]).not.toBe("run_code");
	expect(input.instructions).toContain(codeModeInstructions("core"));
	expect(input.instructions).not.toContain("run_code is your main tool");
	for (const name of ["bash", "read", "agent", "web_fetch", "update_plan"])
		expect(input.tools.run_code.description).toContain(`tools.${name}(args)`);
});

it("gives product agents the bridge's web_fetch, subagents included", async () => {
	const description = (
		webFetchTool({ checkHost: async () => true }).web_fetch as {
			description?: string;
		}
	).description;
	expect(
		(await offered(PRODUCT_HARNESS_VARIANT)).tools.web_fetch?.description,
	).toBe(description);
	expect(Object.keys((await offered({})).tools)).not.toContain("web_fetch");
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		taskAccess: "read_write",
		parentSessionId: "parent",
		agentRole: "builder",
	});
	expect(Object.keys((await offered(PRODUCT_HARNESS_VARIANT)).tools)).toContain(
		"web_fetch",
	);
});

it("refuses private and metadata hosts from a product turn's web_fetch", async () => {
	mocks.variant.mockResolvedValue(PRODUCT_HARNESS_VARIANT);
	mocks.promptSubmit.mockResolvedValue({ block: false });
	const outcomes: unknown[] = [];
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		for (const url of [
			"http://169.254.169.254/latest/meta-data/",
			"http://localhost:8080/",
		])
			outcomes.push(
				await input.tools.web_fetch
					.execute({ url }, { toolCallId: url, messages: [] })
					.catch((error: Error) => error.message),
			);
		return [];
	});
	await runApiTurn({} as WorkspaceMachines, subscriptionTurn);
	expect(outcomes).toEqual([
		expect.stringMatching(/169\.254\.169\.254 is not a public host/),
		expect.stringMatching(/localhost is not a public host/),
	]);
});
