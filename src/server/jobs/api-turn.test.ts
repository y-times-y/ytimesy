import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import { CoordinationFailure } from "#/domain/conversation-turn-control";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { loadModelConnection } from "../adapters/model-connections";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	attachments: vi.fn(async (..._args: unknown[]) => {}),
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
	loop: vi.fn(),
	reviewLoop: vi.fn(),
	beforeModel: vi.fn(),
	afterAttempt: vi.fn(),
	leadGate: vi.fn(async (): Promise<"ready" | "busy" | "wait"> => "ready"),
	/** A lean surface (lead mode needs one); off by default. */
	lean: null as null | Record<string, unknown>,
	/** Cross-chat memory for the root builder; off unless a test sets one. */
	turnMemory: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
	/** The lifecycle hooks' input, for its live redaction list. */
	hooksInput: { current: null as null | { redact?: readonly string[] } },
	subagentMemory: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
	/** The turn's workspace preparation (ready at once unless a test holds it). */
	workspace: vi.fn(),
	/** The checked-out workspace before baselines; undefined: the whole preparation. */
	checkedOut: vi.fn((): Promise<unknown> | undefined => undefined),
	/** The repository path the chat last reported (none unless a test sets one). */
	preparedDirectory: vi.fn(),
	/** The chat's pinned baseline and its journaled hook configuration. */
	baseline: vi.fn(),
	hookConfig: vi.fn(),
	/** A new chat's commit known before its VM, and its project's journaled configurations. */
	pinnedBase: vi.fn(async (): Promise<string | null> => null),
	projectHookConfig: vi.fn(
		async (..._args: unknown[]): Promise<unknown> => null,
	),
	/** The pinned commit's hook file as GitHub has it (null: GitHub cannot say). */
	pinnedBaseFile: vi.fn(
		async (
			..._args: unknown[]
		): Promise<{ present: false } | { present: true; text: string } | null> =>
			null,
	),
}));
vi.mock("../adapters/prepared-checkout", () => ({
	MACHINE_PREWARM_KEY: "machine-prewarm",
	readPreparedCheckoutDirectory: mocks.preparedDirectory,
	savePreparedCheckoutDirectory: vi.fn(async () => {}),
	readSessionDerivedValue: mocks.hookConfig,
	readProjectDerivedValue: mocks.projectHookConfig,
	saveSessionDerivedValue: vi.fn(async () => {}),
}));
// Memory is off unless a test turns it on; the real one is in turn-memory.test.ts.
vi.mock("../services/turn-memory", () => ({
	turnMemory: mocks.turnMemory,
	subagentMemory: mocks.subagentMemory,
}));
// Development eval users pick harness variants; everyone else gets the default.
vi.mock("../services/subagent-runtime", async (original) => ({
	...(await original<typeof import("../services/subagent-runtime")>()),
	subagentReport: async (input: { text: string }) => input.text,
}));
vi.mock("../adapters/dev-eval-users", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/dev-eval-users")>()),
	devEvalUsersEnabled: () => mocks.variant() !== undefined,
	harnessVariantForUser: async () => mocks.variant(),
	isDevEvalUser: async () => false,
}));
vi.mock("../services/attempt-loop", () => ({ createAttemptLoop: mocks.loop }));
// Lead mode fusion's gate and completion check (their rule is tested in fusion-lead.test.ts).
vi.mock("../services/fusion-lead", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/fusion-lead")>()),
	fusionLeadGate: mocks.leadGate,
}));
vi.mock("../services/review-loop", () => ({
	createReviewLoop: mocks.reviewLoop,
}));
vi.mock("../services/attempt-loop-deps", () => ({
	attemptLoopDeps: () => ({}),
	reviewLoopDeps: () => ({}),
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
			mocks.hooksInput.current = input;
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
vi.mock("../services/api-agent-command-tools", () => ({
	completedAgentCommands: mocks.commandCompletions,
}));
vi.mock("../services/turn-commit", () => ({
	commitCompletedSessionTurn: mocks.commit,
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
	mocks.turnMemory.mockReset().mockResolvedValue(null);
	mocks.subagentMemory.mockReset().mockResolvedValue(null);
	mocks.variant.mockReset().mockReturnValue(undefined);
	mocks.reviewLoop.mockReset().mockImplementation(() => ({
		beforeModel: mocks.beforeModel,
		afterAttempt: mocks.afterAttempt,
	}));
	mocks.loop.mockReset().mockImplementation(() => ({
		beforeModel: mocks.beforeModel,
		afterAttempt: mocks.afterAttempt,
	}));
	mocks.beforeModel.mockReset().mockResolvedValue({ kind: "run" });
	mocks.afterAttempt.mockReset();
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
	mocks.lean = null;
	mocks.workspace
		.mockReset()
		.mockImplementation(async () => ({ machines: {}, vm: "vm", cwd: "/repo" }));
	mocks.checkedOut.mockReset().mockReturnValue(undefined);
	mocks.preparedDirectory.mockReset().mockResolvedValue(null);
	mocks.baseline.mockReset().mockResolvedValue(null);
	mocks.hookConfig.mockReset().mockResolvedValue(null);
	mocks.pinnedBase.mockReset().mockResolvedValue(null);
	mocks.projectHookConfig.mockReset().mockResolvedValue(null);
	mocks.pinnedBaseFile.mockReset().mockResolvedValue(null);
	mocks.promptSubmit.mockReset().mockResolvedValue(undefined);
	mocks.cancelRequested.mockReset().mockResolvedValue(false);
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.result.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
});

it("refuses publication when leftover command fencing cannot be confirmed", async () => {
	mocks.stepRuntime.mockImplementation(async (input) => {
		await input.tools.workspace();
		await input.onEvent({ type: "text-delta", id: "reply", text: "Finished." });
		return { messages: input.messages, outcome: "completed" };
	});
	mocks.stop.mockRejectedValueOnce(new Error("Cancellation uncertain"));
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [],
		items: [],
		lease_id: "lease",
	} as ApiTurn;
	expect(
		await runApiTurn({} as WorkspaceMachines, turn, {
			index: 1,
			signal: new AbortController().signal,
		}),
	).toBe("failed");
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"failed",
		expect.anything(),
	);
});

it.each(["running", "completed"])(
	"does not publish a final answer before %s background work has been reviewed",
	async (state) => {
		const id = "b6794616-ec28-4390-831f-7d3ddf9f8621";
		if (state === "completed")
			mocks.commandCompletions.mockResolvedValue([
				{ id, status: 0, stopped: null },
			]);
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({
				type: "text-delta",
				id: "reply",
				text: "Finished.",
			});
			return { messages: input.messages, outcome: "completed" };
		});
		const turn = {
			id: "turn",
			session_id: "session",
			user_id: "owner",
			connection_id: "connection",
			connection_revision: "revision",
			model_id: "model",
			state: "running",
			messages: [],
			items: [
				{
					kind: "dynamicToolCall",
					id: SessionItemId("background"),
					tool: "start_command",
					status: "completed",
					output: JSON.stringify({ id, status: "running" }),
				},
			],
			lease_id: "lease",
		} as ApiTurn;
		expect(
			await runApiTurn({} as WorkspaceMachines, turn, {
				index: 1,
				signal: new AbortController().signal,
			}),
		).toBe("continue");
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.stop).not.toHaveBeenCalled();
		if (state === "running") {
			// The builder waits with continue_command; it has no wait_command.
			const saved = JSON.stringify(mocks.checkpoint.mock.calls.at(-1)?.[1]);
			expect(saved).toContain("Use continue_command to wait for them");
			expect(saved).not.toContain("wait_command");
		}
		expect(coordinateConversationTurn).not.toHaveBeenCalledWith(
			"release",
			expect.anything(),
		);
	},
);
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
vi.mock("../services/message-attachments", async (original) => ({
	...(await original<typeof import("../services/message-attachments")>()),
	materializeMessageAttachments: (...args: unknown[]) =>
		mocks.attachments(...args),
}));
// Root chats are builders: each turn records a code point before it edits.
vi.mock("../services/conversation-recovery", () => ({
	ensureConversationCodePoint: vi.fn(async () => {}),
}));
vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: mocks.baseline,
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
vi.mock("../services/api-agent-tools", () => ({
	apiAgentTools: (input: unknown) =>
		Object.fromEntries(
			Object.entries(input as Record<string, unknown>).filter(
				([, value]) => value !== undefined,
			),
		),
}));
// The mocked tool set carries probe fields; the shell filter has its own tests.
vi.mock("../services/builder-shell-surface", () => ({
	builderToolSurface: ({ tools }: { tools: unknown }) =>
		mocks.lean ? { tools, lean: mocks.lean } : { tools },
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
	deferredApiTurnWorkspace: () => {
		let prepared: Promise<unknown> | undefined;
		return Object.assign(
			() => {
				prepared ??= mocks.workspace();
				return prepared;
			},
			{
				pinnedBase: mocks.pinnedBase,
				pinnedBaseFile: mocks.pinnedBaseFile,
				checkedOut: () => mocks.checkedOut(),
			},
		);
	},
}));
vi.mock("../services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

it("gives the builder no cross-chat project memory and needs no VM to answer", async () => {
	mocks.runtime.mockImplementation(async (input) => {
		expect(input.instructions).not.toContain(
			"Branch selection is implemented in branch.ts",
		);
		expect(input.instructions).not.toContain("Shared project knowledge");
		await input.onEvent({
			type: "text-delta",
			id: "reply",
			text: "The branch picker already exists.",
		});
		return [];
	});
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Fix branches" }],
		items: [
			{ kind: "userMessage", id: SessionItemId("user"), text: "Fix branches" },
		],
		lease_id: "lease",
	} as ApiTurn;
	expect(await runApiTurn({} as WorkspaceMachines, turn)).toBe("completed");
	expect(mocks.report).toHaveBeenCalledOnce();
	expect(mocks.knowledge).not.toHaveBeenCalled();
});

it("keeps completion capture and no cross-chat memory for Codex subscription turns", async () => {
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		expect(input.instructions).not.toContain(
			"Branch selection is implemented in branch.ts",
		);
		await input.onEvent({
			type: "text-delta",
			id: "reply",
			text: "The branch picker already exists.",
		});
		return [];
	});
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: null,
		connection_revision: subscriptionTurnRevision("medium"),
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Fix branches" }],
		items: [
			{ kind: "userMessage", id: SessionItemId("user"), text: "Fix branches" },
		],
		lease_id: "lease",
	} as ApiTurn;
	expect(await runApiTurn({} as WorkspaceMachines, turn)).toBe("completed");
	expect(mocks.subscriptionRuntime).toHaveBeenCalledOnce();
	expect(mocks.subscriptionRuntime.mock.calls[0][0].tools.nativePatch).toBe(
		false,
	);
	expect(mocks.subscriptionRuntime.mock.calls[0][0].tools.freeformPatch).toBe(
		true,
	);
	expect(mocks.runtime).not.toHaveBeenCalled();
	expect(mocks.report).toHaveBeenCalledOnce();
});

describe("a Codex subscription (ChatGPT plan) root chat publishes like an API chat", () => {
	const subscriptionTurn = (extra: Partial<ApiTurn> = {}) =>
		({
			id: "turn",
			session_id: "session",
			user_id: "owner",
			connection_id: null,
			connection_revision: subscriptionTurnRevision("medium"),
			model_id: "gpt-5.5",
			state: "running",
			messages: [{ role: "user", content: "Fix branches" }],
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("user"),
					text: "Fix branches",
				},
			],
			lease_id: "lease",
			...extra,
		}) as ApiTurn;
	const codexOwner = (extra: Record<string, unknown> = {}) =>
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "codex",
			providerRef: "vm",
			parentSessionId: null,
			taskAccess: null,
			...extra,
		});
	const answering = () =>
		mocks.subscriptionRuntime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await input.onEvent({ type: "text-delta", id: "reply", text: "Done." });
			return [];
		});

	it("commits and pushes the turn at the completion boundary on its machine", async () => {
		codexOwner();
		answering();
		mocks.commit.mockResolvedValueOnce({
			publication: {
				branch: "ytimesy/fix-branches-abc123",
				pullRequestUrl: null,
			},
		});
		expect(await runApiTurn({} as WorkspaceMachines, subscriptionTurn())).toBe(
			"completed",
		);
		expect(mocks.subscriptionRuntime).toHaveBeenCalledOnce();
		expect(mocks.commit).toHaveBeenCalledOnce();
		expect(mocks.commit.mock.calls[0][0]).toMatchObject({
			id: "session",
			harness: "codex",
			providerRef: "vm",
		});
	});

	it("shows why its changes were not pushed and still completes", async () => {
		codexOwner();
		answering();
		mocks.commit.mockResolvedValueOnce({
			notice: "Changes are committed in this chat but were not pushed.",
		});
		expect(await runApiTurn({} as WorkspaceMachines, subscriptionTurn())).toBe(
			"completed",
		);
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"completed",
			expect.arrayContaining([
				expect.objectContaining({ kind: "notice", id: "turn:publication" }),
			]),
		);
	});

	it("commits nothing for a subagent", async () => {
		codexOwner({ agentRole: "writer", parentSessionId: "parent" });
		answering();
		await runApiTurn({} as WorkspaceMachines, subscriptionTurn());
		expect(mocks.commit).not.toHaveBeenCalled();
	});
});

it("stops command groups on abort while the model loop is still awaiting a tool", async () => {
	let finishTool: () => void = () => {
		throw new Error("Tool was not started");
	};
	mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.runtime.mockImplementation(async (input) => {
		await input.tools.workspace();
		await new Promise<void>((resolve) => {
			finishTool = resolve;
		});
	});
	mocks.stop.mockImplementation(async () => {
		expect(mocks.finalize).not.toHaveBeenCalled();
		finishTool();
	});
	await runApiTurn(
		{} as WorkspaceMachines,
		{
			id: "00000000-0000-4000-8000-000000000001",
			session_id: "session",
			user_id: "owner",
			connection_id: "connection",
			connection_revision: "revision",
			model_id: "model",
			state: "running",
			messages: [],
			items: [],
			lease_id: "00000000-0000-4000-8000-000000000002",
		} as ApiTurn,
	);
	expect(mocks.stop).toHaveBeenCalledTimes(1);
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"cancelled",
		expect.anything(),
	);
});

it("classifies heartbeat failures without logging database error details", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const privateError = Object.assign(new Error("secret query credentials"), {
			code: "ECONNRESET",
		});
		mocks.renew.mockResolvedValueOnce(true).mockRejectedValue(privateError);
		mocks.runtime.mockImplementation(async (input) => {
			await new Promise<void>((resolve) => {
				input.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			input.signal.throwIfAborted();
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(1001);
		await run;
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.anything(),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "failed",
				summary: expect.stringContaining(
					"heartbeat or coordination service became unavailable",
				),
			}),
		);
		expect(mocks.enqueue).toHaveBeenCalledWith("event");
		expect(warn).toHaveBeenCalledWith("Turn heartbeat failed", {
			stage: "database-renewal",
			code: "ECONNRESET",
			name: "Error",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret query");
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});

it("keeps coordinator failure primary when renewal aborts the provider stream", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			if (action === "renew")
				throw new CoordinationFailure(
					"renew",
					{ kind: "http", status: 503 },
					2,
				);
			return true;
		});
		mocks.runtime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await new Promise<void>((resolve) =>
				input.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("private provider stream and credentials");
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(10_001);
		await run;
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.stop).toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.anything(),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "failed",
				summary: expect.stringContaining("HTTP 503, 2 attempts"),
			}),
		);
		expect(warn).toHaveBeenCalledWith(
			"API turn failed",
			expect.objectContaining({
				stage: "coordination",
				name: "CoordinationFailure",
				attempts: 2,
			}),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private provider");
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});

it("stops a writer on lease conflict without retrying inference or publication", async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "renew",
		);
		mocks.runtime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await new Promise<void>((resolve) =>
				input.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			input.signal.throwIfAborted();
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(await run).toBe("cancelled");
		expect(mocks.runtime).toHaveBeenCalledOnce();
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(
			vi
				.mocked(coordinateConversationTurn)
				.mock.calls.filter(([action]) => action === "renew"),
		).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

it("fences a resumed parent against a real isolated coordinator outage", async () => {
	const { startEvaluationCoordinator } = await import(
		"../../../benchmarks/evaluation/coordination"
	);
	const actual = await vi.importActual<
		typeof import("../adapters/conversation-turn-control")
	>("../adapters/conversation-turn-control");
	vi.mocked(coordinateConversationTurn).mockImplementation(
		actual.coordinateConversationTurn,
	);
	const coordinator = await startEvaluationCoordinator();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const fetcher = globalThis.fetch;
	const resumed = {
		...childTurn,
		session_id: "11111111-1111-4111-8111-111111111111",
	};
	const previous = {
		userId: resumed.user_id,
		sessionId: resumed.session_id,
		turnId: "22222222-2222-4222-8222-222222222222",
		leaseId: "33333333-3333-4333-8333-333333333333",
	};
	try {
		expect(await actual.coordinateConversationTurn("acquire", previous)).toBe(
			true,
		);
		expect(await actual.coordinateConversationTurn("release", previous)).toBe(
			true,
		);
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) =>
				String(input).endsWith("/turn/renew")
					? new Response(null, { status: 503 })
					: fetcher(input, init),
		);
		mocks.runtime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await new Promise<void>((resolve) =>
				input.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("aborted provider stream");
		});
		expect(await runApiTurn({} as WorkspaceMachines, resumed)).toBe("failed");
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: expect.stringContaining("HTTP 503, 2 attempts"),
			}),
		);
		vi.unstubAllGlobals();
		expect(
			await actual.coordinateConversationTurn("renew", {
				...previous,
				turnId: resumed.id,
				leaseId: String(resumed.lease_id),
			}),
		).toBe(false);
	} finally {
		vi.unstubAllGlobals();
		warn.mockRestore();
		await coordinator.close();
	}
}, 30_000);

const childTurn = {
	id: "00000000-0000-4000-8000-000000000001",
	session_id: "session",
	user_id: "owner",
	connection_id: "connection",
	connection_revision: "revision",
	model_id: "model",
	state: "running",
	messages: [],
	items: [],
	lease_id: "00000000-0000-4000-8000-000000000002",
} as ApiTurn;

it("reads the API connection while acquiring the lease, not after it", async () => {
	const order: string[] = [];
	vi.mocked(loadModelConnection).mockImplementationOnce(async () => {
		order.push("connection");
		return { revision: "revision" } as never;
	});
	vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
		if (action === "acquire") {
			// The connection read is already under way.
			await Promise.resolve();
			order.push("acquired");
		}
		return true;
	});
	mocks.runtime.mockImplementation(async (input) => {
		await input.onEvent({ type: "text-delta", id: "reply", text: "ok" });
		return { messages: input.messages, outcome: "completed" };
	});
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(order).toEqual(["connection", "acquired"]);
	expect(loadModelConnection).toHaveBeenCalledWith("owner", "connection");
});

it("renews coordination while a database heartbeat is waiting", async () => {
	vi.useFakeTimers();
	let completeHeartbeat: (alive: boolean) => void = () => {};
	let completeModel: () => void = () => {};
	try {
		mocks.renew.mockResolvedValueOnce(true).mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					completeHeartbeat = resolve;
				}),
		);
		mocks.runtime.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeModel = resolve;
				}),
		);
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(20_001);
		expect(
			vi
				.mocked(coordinateConversationTurn)
				.mock.calls.filter(([action]) => action === "renew"),
		).toHaveLength(2);
		completeHeartbeat(true);
		completeModel();
		await run;
	} finally {
		completeHeartbeat(true);
		completeModel();
		vi.useRealTimers();
	}
});

it("awaits an in-flight heartbeat before the invocation can close its database pool", async () => {
	vi.useFakeTimers();
	try {
		let completeHeartbeat: (alive: boolean) => void = () => {};
		let completeModel: () => void = () => {};
		mocks.renew.mockResolvedValueOnce(true).mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					completeHeartbeat = resolve;
				}),
		);
		mocks.runtime.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeModel = resolve;
				}),
		);
		let settled = false;
		const run = runApiTurn({} as WorkspaceMachines, childTurn).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(1001);
		completeModel();
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		completeHeartbeat(true);
		await run;
		expect(settled).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it("immediately queues a completed subagent's parent event", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
		agentRole: "researcher",
	});
	mocks.runtime.mockImplementation(async (input) =>
		input.onEvent({ type: "text-delta", id: "answer", text: "Done" }),
	);
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(mocks.result).toHaveBeenCalledWith(
		expect.objectContaining({ eventType: "completed" }),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});

it("gives a subagent the project's memory read only: attached to its request, never saved", async () => {
	const saveHook = vi.fn();
	const rootMemory = {
		mode: "full",
		instructions: "memory instructions",
		prepareVm: vi.fn(),
		vmTokens: () => [],
		releaseVm: vi.fn(),
		attach: vi.fn(),
		recordSaved: vi.fn(),
		afterTurn: saveHook,
	};
	mocks.turnMemory.mockResolvedValue(rootMemory);
	const attach = vi.fn(async (messages: { content: unknown }[]) => ({
		messages: messages.map((message) => ({
			...message,
			content: [
				{ type: "text", text: String(message.content) },
				{ type: "text", text: "<memory>\nProject rules\n</memory>" },
			],
		})),
		recall: { head: "abc", lines: [] },
	}));
	mocks.subagentMemory.mockResolvedValue({ attach });
	const seen: { instructions: string; messages: unknown }[] = [];
	mocks.runtime.mockImplementation(async (input) => {
		seen.push({ instructions: input.instructions, messages: input.messages });
		return [];
	});
	mocks.promptSubmit.mockResolvedValue({ block: false });
	const brief = {
		...childTurn,
		messages: [{ role: "user", content: "Check the export" }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("brief"),
				text: "Check the export",
			},
		],
	} as ApiTurn;
	for (const agentRole of ["checker", "writer"] as const) {
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			parentSessionId: "parent",
			taskAccess: agentRole === "writer" ? "read_write" : "read_only",
			agentRole,
		});
		await runApiTurn({} as WorkspaceMachines, brief);
		expect(mocks.subagentMemory).toHaveBeenLastCalledWith(
			expect.objectContaining({ userId: "owner", projectId: "project" }),
			expect.anything(),
		);
		expect(mocks.subagentMemory.mock.lastCall?.[0]).toMatchObject({
			role: agentRole,
		});
	}
	expect(attach).toHaveBeenCalledTimes(2);
	expect(seen).toHaveLength(2);
	for (const request of seen) {
		expect(JSON.stringify(request.messages)).toContain("Project rules");
		// No memory instructions: a child is never told to write memory.
		expect(request.instructions).not.toContain("memory instructions");
	}
	// Only the root chat's memory has a save hook, and a child never loads it.
	expect(mocks.turnMemory).not.toHaveBeenCalled();
	expect(saveHook).not.toHaveBeenCalled();
	expect(rootMemory.prepareVm).not.toHaveBeenCalled();
	expect(rootMemory.recordSaved).not.toHaveBeenCalled();
});

it("tells builders their repository instructions are supplied, with the same system prompt every turn", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
		taskAccess: "read_write",
		agentRole: "writer",
	});
	const seen: string[] = [];
	const capture = async (input: { instructions: string }) => {
		seen.push(input.instructions);
		return [];
	};
	// Writable builders' prompt hook needs a database this test does not have.
	mocks.promptSubmit.mockResolvedValue({ block: false });
	mocks.runtime.mockImplementation(capture);
	mocks.subscriptionRuntime.mockImplementation(capture);
	await runApiTurn({} as WorkspaceMachines, childTurn);
	await runApiTurn({} as WorkspaceMachines, childTurn);
	await runApiTurn(
		{} as WorkspaceMachines,
		{
			...childTurn,
			connection_id: null,
			connection_revision: subscriptionTurnRevision("medium"),
		} as ApiTurn,
	);
	expect(seen).toHaveLength(3);
	expect(seen[1]).toBe(seen[0]);
	for (const instructions of seen) {
		expect(instructions).not.toContain("read_repository_guidance");
		expect(instructions).toContain(
			"Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat",
		);
	}
});

it("consumes streaming deltas without waiting for storage but drains before checkpoint and completion", async () => {
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	mocks.progress
		.mockResolvedValueOnce(undefined)
		.mockImplementationOnce(() => pending);
	mocks.runtime.mockImplementation(async (input) => {
		await input.onEvent({ type: "text-delta", id: "reply", text: "First" });
		await input.onEvent({ type: "text-delta", id: "reply", text: " second" });
		expect(mocks.progress).toHaveBeenCalledTimes(2);
		const checkpoint = input.onStep(input.messages);
		await Promise.resolve();
		expect(mocks.checkpoint).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		release();
		await checkpoint;
		return input.messages;
	});
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(mocks.checkpoint).toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"completed",
		expect.anything(),
	);
});

it("classifies asynchronous progress-storage errors as failures rather than user cancellations", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		mocks.progress
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("private database detail"));
		mocks.runtime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "First" });
			await input.onStep(input.messages);
			return input.messages;
		});
		expect(await runApiTurn({} as WorkspaceMachines, childTurn)).toBe("failed");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: expect.stringContaining("progress could not be saved"),
				}),
			]),
		);
		expect(JSON.stringify(mocks.finalize.mock.calls)).not.toContain(
			"private database detail",
		);
	} finally {
		warn.mockRestore();
	}
});

it("does not show a storage failure for progress fenced by the user's cancellation", async () => {
	mocks.progress
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new ApiTurnCancelled());
	mocks.runtime.mockImplementation(async (input) => {
		await input.onEvent({ type: "text-delta", id: "reply", text: "First" });
		await input.onStep(input.messages);
		return input.messages;
	});
	expect(await runApiTurn({} as WorkspaceMachines, childTurn)).toBe(
		"cancelled",
	);
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"cancelled",
		expect.not.arrayContaining([expect.objectContaining({ kind: "error" })]),
	);
});

it("saves and queues child failures, including failures before runtime startup", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
	});
	mocks.runtime.mockRejectedValue(new Error("Model unavailable"));
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(mocks.result).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: "session", eventType: "failed" }),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});

it("distinguishes completion coordination failures from progress-save failures without logging details", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			if (action === "release")
				throw new DOMException("private host and token", "TimeoutError");
			return true;
		});
		mocks.runtime.mockImplementation(async (input) =>
			input.onEvent({ type: "text-delta", id: "answer", text: "Done" }),
		);
		await runApiTurn({} as WorkspaceMachines, childTurn);
		expect(warn).toHaveBeenCalledWith("API turn failed", {
			stage: "coordination",
			name: "TimeoutError",
			code: "unknown",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private host");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: expect.stringContaining("coordinator"),
				}),
			]),
		);
	} finally {
		warn.mockRestore();
	}
});

it("keeps a durable tool boundary running, preserving cumulative usage and distinct stream IDs", async () => {
	mocks.stepRuntime.mockImplementation(async (input) => {
		await input.onEvent({ type: "text-delta", id: "0", text: "Next step" });
		await input.onEvent({
			type: "usage",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				uncachedInputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		});
		await input.onStep([
			{ role: "user", content: "Task" },
			{ role: "assistant", content: "Next step" },
		]);
		return { outcome: "continue", messages: [] };
	});
	const result = await runApiTurn(
		{} as WorkspaceMachines,
		{
			...childTurn,
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("user"),
					text: "Task",
					apiUsage: {
						inputTokens: 10,
						outputTokens: 4,
						uncachedInputTokens: 10,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
			],
		},
		{ index: 2, signal: new AbortController().signal },
	);
	expect(result).toBe("continue");
	expect(mocks.finalize).not.toHaveBeenCalled();
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.result).not.toHaveBeenCalled();
	const { checkpointApiTurn } = await import("../adapters/api-turns");
	// The step's history is saved once; the unchanged end-of-step saves are skipped.
	expect(checkpointApiTurn).toHaveBeenCalledTimes(1);
	expect(checkpointApiTurn).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		expect.arrayContaining([
			expect.objectContaining({
				id: `${childTurn.id}:step-2:0`,
				text: "Next step",
			}),
			expect.objectContaining({
				kind: "userMessage",
				apiUsage: expect.objectContaining({ inputTokens: 13, outputTokens: 6 }),
			}),
		]),
	);
});

it.each([false, true])(
	"hands off completed turns before finalization; handoff failure=%s",
	async (fails) => {
		const order: string[] = [];
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			providerRef: "executor",
			taskAccess: "read_write",
			taskPlacement: "fresh",
		});
		mocks.runtime.mockImplementation(async (input) => {
			order.push("model");
			await input.onEvent({
				type: "text-delta",
				id: "reply",
				text: "Completed changes",
			});
		});
		mocks.commit.mockImplementation(async () => {
			order.push("commit");
			if (fails) throw new Error("Git handoff rejected");
		});
		mocks.finalize.mockImplementation(async (_turn, state) => {
			order.push(state);
			return state;
		});
		expect(await runApiTurn({} as WorkspaceMachines, childTurn)).toBe(
			fails ? "failed" : "completed",
		);
		expect(order).toEqual(["model", "commit", fails ? "failed" : "completed"]);
		// The builder commits from the workspace its turn prepared.
		expect(mocks.commit.mock.calls[0][0].providerRef).toBe("vm");
		if (fails)
			expect(mocks.finalize.mock.calls[0][2]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "error",
						message: expect.stringContaining("automatic Git handoff failed"),
					}),
				]),
			);
	},
);

it("does not commit or publish a turn with no final result", async () => {
	mocks.runtime.mockResolvedValue([]);
	expect(await runApiTurn({} as WorkspaceMachines, childTurn)).toBe("failed");
	expect(mocks.commit).not.toHaveBeenCalled();
});

it("finishes a bounded step limit without starting inference or publishing a fake success", async () => {
	mocks.stepRuntime.mockClear();
	expect(
		await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 31,
			signal: new AbortController().signal,
			limitReached: true,
		}),
	).toBe("failed");
	expect(mocks.stepRuntime).not.toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"failed",
		expect.arrayContaining([
			expect.objectContaining({
				kind: "error",
				message: expect.stringContaining("tool-step limit"),
			}),
		]),
	);
});

it.each([false, true])(
	"admits builder step 31 for root chats and writer subagents (child: %s)",
	async (child) => {
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			...(child
				? {
						parentSessionId: "parent",
						taskAccess: "read_write",
						taskPlacement: "fresh",
						agentRole: "writer",
					}
				: {}),
		});
		mocks.stepRuntime.mockResolvedValue({ messages: [], outcome: "continue" });
		expect(
			await runApiTurn({} as WorkspaceMachines, childTurn, {
				index: 31,
				signal: new AbortController().signal,
			}),
		).toBe("continue");
		expect(mocks.stepRuntime).toHaveBeenCalledOnce();
		expect(mocks.commit).not.toHaveBeenCalled();
	},
);

it("settles builder overflow without inference even if the caller omits its limit flag", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
		taskAccess: "read_write",
		taskPlacement: "fresh",
	});
	expect(
		await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 129,
			signal: new AbortController().signal,
		}),
	).toBe("failed");
	expect(mocks.stepRuntime).not.toHaveBeenCalled();
	expect(mocks.commit).not.toHaveBeenCalled();
});

it("runs the UserPromptSubmit hook on a durable turn's first step only", async () => {
	mocks.promptSubmit.mockResolvedValue({ block: true, reason: "No." });
	expect(
		await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 1,
			signal: new AbortController().signal,
		}),
	).toBe("failed");
	expect(mocks.promptSubmit).toHaveBeenCalledOnce();
	expect(mocks.stepRuntime).not.toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"failed",
		expect.arrayContaining([
			expect.objectContaining({
				kind: "error",
				message: expect.stringContaining("UserPromptSubmit hook: No."),
			}),
		]),
	);
	mocks.promptSubmit.mockClear();
	mocks.stepRuntime.mockResolvedValue({ messages: [], outcome: "continue" });
	expect(
		await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 2,
			signal: new AbortController().signal,
		}),
	).toBe("continue");
	expect(mocks.promptSubmit).not.toHaveBeenCalled();
});

function hangUntilAborted(input: { signal: AbortSignal }) {
	return new Promise((_resolve, reject) =>
		input.signal.addEventListener("abort", () => reject(input.signal.reason)),
	);
}

it("treats a Stop noticed by the heartbeat as the user's clean stop", async () => {
	vi.useFakeTimers();
	try {
		mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
		mocks.cancelRequested.mockResolvedValue(true);
		mocks.stepRuntime.mockImplementation(hangUntilAborted);
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 1,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(1_500);
		expect(await outcome).toBe("cancelled");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"cancelled",
			expect.not.arrayContaining([expect.objectContaining({ kind: "error" })]),
		);
	} finally {
		vi.useRealTimers();
	}
});

it("settles a Stop during a tool call with that call in the saved history", async () => {
	vi.useFakeTimers();
	try {
		mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
		mocks.cancelRequested.mockResolvedValue(true);
		const inFlight = [
			{ role: "user" as const, content: "what is running?" },
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "call-1",
						toolName: "exec_command",
						input: { cmd: "sleep 60; echo marker-one" },
					},
				],
			},
		];
		mocks.stepRuntime.mockImplementation(
			(
				input: Parameters<typeof hangUntilAborted>[0] & {
					messages: unknown[];
					onAttemptFailed: (state: unknown) => void;
				},
			) =>
				hangUntilAborted(input).catch((error: unknown) => {
					input.onAttemptFailed({
						committed: input.messages,
						droppedStepSaved: false,
						uncommittedIds: [],
						inFlight,
					});
					throw error;
				}),
		);
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 1,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(1_500);
		expect(await outcome).toBe("cancelled");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"cancelled",
			expect.anything(),
			inFlight,
		);
	} finally {
		vi.useRealTimers();
	}
});

it("still reports a lost turn lease that the user did not ask to stop", async () => {
	vi.useFakeTimers();
	try {
		mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
		mocks.stepRuntime.mockImplementation(hangUntilAborted);
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 1,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(1_500);
		await outcome;
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"cancelled",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: expect.stringContaining("Turn ownership"),
				}),
			]),
		);
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	["a subagent", { parentSessionId: "parent", agentRole: "researcher" }],
	["a root chat", {}],
])(
	"fails %s out of time with a time-limit message and notifies its parent",
	async (_kind, extra) => {
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			...extra,
		});
		mocks.stepRuntime.mockImplementation(hangUntilAborted);
		const deadline = new AbortController();
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 3,
			signal: deadline.signal,
		});
		await vi.waitFor(() => expect(mocks.stepRuntime).toHaveBeenCalled());
		deadline.abort(new DOMException("Turn deadline reached.", "TimeoutError"));
		expect(await outcome).toBe("failed");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: expect.stringContaining("reached its time limit"),
				}),
			]),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "failed",
				summary: expect.stringContaining("reached its time limit"),
			}),
		);
	},
);

it("keeps an interrupted durable step that was not out of time a plain stop", async () => {
	mocks.stepRuntime.mockImplementation(hangUntilAborted);
	const request = new AbortController();
	const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
		index: 2,
		signal: request.signal,
	});
	await vi.waitFor(() => expect(mocks.stepRuntime).toHaveBeenCalled());
	request.abort();
	expect(await outcome).toBe("cancelled");
});

it("waits for a code restore's brief hold on the chat instead of failing the turn", async () => {
	vi.useFakeTimers();
	try {
		let held = 3;
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "acquire" || --held < 0,
		);
		mocks.runtime.mockImplementation(async (input) =>
			input.onEvent({ type: "text-delta", id: "answer", text: "Done" }),
		);
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(3_500);
		expect(await run).toBe("completed");
		expect(
			vi
				.mocked(coordinateConversationTurn)
				.mock.calls.filter(([action]) => action === "acquire"),
		).toHaveLength(4);
		expect(mocks.runtime).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});

it("gives up acquiring a chat that stays held past one lease period", async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "acquire",
		);
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(await run).toBe("failed");
		expect(mocks.runtime).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});

describe("the attempt loop (harness variant attempts=3)", () => {
	const rootTurn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Fix compaction" }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Fix compaction",
			},
		],
		lease_id: "lease",
	} as ApiTurn;
	const durable = () => ({ index: 2, signal: new AbortController().signal });
	const finishing = () =>
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "Fixed." });
			return { messages: input.messages, outcome: "completed" };
		});

	it("lead=fusion: Main is released during a build round: the turn completes while it runs", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			lead: "fusion",
		});
		finishing();
		mocks.lean = {
			shape: "core",
			readOnly: false,
			commandReader: "read_command",
			waitHint: () => "",
			saveHistory: async () => null,
		};
		mocks.leadGate.mockReset().mockResolvedValueOnce("busy");
		expect(
			await runApiTurn(
				{} as WorkspaceMachines,
				{ ...rootTurn, id: "turn-lead" },
				durable(),
			),
		).toBe("completed");
		expect(mocks.leadGate).toHaveBeenCalledOnce();
		expect(mocks.commit).toHaveBeenCalledOnce();
		mocks.leadGate.mockResolvedValue("ready");
		mocks.lean = null;
	});

	it("is off by default: no loop, the turn completes as before", async () => {
		finishing();
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn, durable())).toBe(
			"completed",
		);
		expect(mocks.loop).not.toHaveBeenCalled();
		expect(mocks.reviewLoop).not.toHaveBeenCalled();
		expect(mocks.commit).toHaveBeenCalledOnce();
	});

	it("shows why a root chat's changes were not pushed, and still completes", async () => {
		finishing();
		mocks.commit.mockResolvedValueOnce({
			notice: "Changes are committed in this chat but were not pushed.",
		});
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn, durable())).toBe(
			"completed",
		);
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"completed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "notice",
					id: "turn:publication",
					message: "Changes are committed in this chat but were not pushed.",
				}),
			]),
		);
	});

	it("review=on hands the checker's findings back to the same run instead of publishing", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			review: "on",
		});
		finishing();
		mocks.afterAttempt.mockResolvedValue({
			kind: "run",
			messages: [
				...rootTurn.messages,
				{ role: "assistant", content: "Fixed." },
				{ role: "user", content: "Runtime notice: review 1 found F1" },
			],
		});
		expect(
			await runApiTurn(
				{} as WorkspaceMachines,
				{ ...rootTurn, id: "turn-review" },
				durable(),
			),
		).toBe("continue");
		expect(mocks.reviewLoop).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session", turnId: "turn-review" }),
		);
		expect(mocks.loop).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.checkpoint.mock.calls.at(-1)?.[1])).toContain(
			"Runtime notice: review 1 found F1",
		);
	});

	it("attempts=3 wins over review=on", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			attempts: "3",
			review: "on",
		});
		finishing();
		mocks.afterAttempt.mockImplementation(async (step) => ({
			kind: "finished",
			messages: step.messages,
			items: step.items,
		}));
		// Another turn: a turn's variant is read once.
		await runApiTurn(
			{} as WorkspaceMachines,
			{ ...rootTurn, id: "turn-both" },
			durable(),
		);
		expect(mocks.loop).toHaveBeenCalledOnce();
		expect(mocks.reviewLoop).not.toHaveBeenCalled();
	});

	it("starts the next attempt instead of publishing when the check fails", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			attempts: "3",
		});
		finishing();
		mocks.afterAttempt.mockResolvedValue({
			kind: "run",
			messages: [
				{ role: "user", content: "Fix compaction" },
				{ role: "user", content: "Runtime notice: attempt 1 failed" },
			],
		});
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn, durable())).toBe(
			"continue",
		);
		expect(mocks.loop).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session", turnId: "turn", max: 3 }),
		);
		expect(mocks.beforeModel).toHaveBeenCalledOnce();
		expect(mocks.afterAttempt).toHaveBeenCalledOnce();
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.checkpoint.mock.calls.at(-1)?.[1])).toContain(
			"Runtime notice: attempt 1 failed",
		);
	});

	it("ends a step that is still waiting for the checker without a model call", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			attempts: "3",
		});
		mocks.beforeModel.mockResolvedValue({ kind: "wait" });
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn, durable())).toBe(
			"continue",
		);
		expect(mocks.stepRuntime).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("completes with the kept attempt once the loop is done", async () => {
		mocks.variant.mockReturnValue({
			...(await import("#/domain/harness-variant")).DEFAULT_HARNESS_VARIANT,
			attempts: "3",
		});
		const items = [
			...rootTurn.items,
			{ kind: "agentMessage", id: SessionItemId("a3"), text: "Attempt 3." },
			{
				kind: "agentMessage",
				id: SessionItemId("attempt-loop:turn:kept"),
				text: "Kept attempt 2 of 3.",
			},
		];
		mocks.beforeModel.mockResolvedValue({
			kind: "finished",
			messages: rootTurn.messages,
			items,
		});
		mocks.afterAttempt.mockImplementation(async (step) => ({
			kind: "finished",
			messages: step.messages,
			items: step.items,
		}));
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn, durable())).toBe(
			"completed",
		);
		expect(mocks.stepRuntime).not.toHaveBeenCalled();
		expect(mocks.commit).toHaveBeenCalledOnce();
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"completed",
			expect.arrayContaining([
				expect.objectContaining({ text: "Kept attempt 2 of 3." }),
			]),
		);
	});
});

describe("the VM's memory token is released however a step ends", () => {
	function fakeMemory() {
		return {
			mode: "full",
			instructions: "",
			prepareVm: vi.fn(async () => {}),
			vmTokens: () => [],
			releaseVm: vi.fn(async () => {}),
			attach: async (messages: unknown) => ({ messages, recall: null }),
			recordSaved: async (items: unknown) => items,
			afterTurn: vi.fn(async () => {}),
		};
	}
	const rootTurn = (id: string) => ({ ...childTurn, id }) as ApiTurn;

	it("on a failed turn", async () => {
		const memory = fakeMemory();
		mocks.turnMemory.mockResolvedValue(memory);
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.tools.workspace();
			throw new Error("Model unavailable");
		});
		expect(
			await runApiTurn(
				{} as WorkspaceMachines,
				rootTurn("00000000-0000-4000-8000-0000000000f1"),
				{ index: 1, signal: new AbortController().signal },
			),
		).toBe("failed");
		expect(memory.prepareVm).toHaveBeenCalledOnce();
		expect(memory.releaseVm).toHaveBeenCalledWith(
			expect.objectContaining({ vm: "vm" }),
		);
	});

	it("on a cancelled turn", async () => {
		vi.useFakeTimers();
		try {
			const memory = fakeMemory();
			mocks.turnMemory.mockResolvedValue(memory);
			mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
			mocks.cancelRequested.mockResolvedValue(true);
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.tools.workspace();
				return hangUntilAborted(input);
			});
			const outcome = runApiTurn(
				{} as WorkspaceMachines,
				rootTurn("00000000-0000-4000-8000-0000000000f2"),
				{ index: 1, signal: new AbortController().signal },
			);
			await vi.advanceTimersByTimeAsync(1_500);
			expect(await outcome).toBe("cancelled");
			expect(memory.releaseVm).toHaveBeenCalledWith(
				expect.objectContaining({ vm: "vm" }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("revokes earlier steps' tokens even when this step never prepared the VM", async () => {
		const memory = fakeMemory();
		mocks.turnMemory.mockResolvedValue(memory);
		mocks.stepRuntime.mockImplementation(async () => {
			throw new Error("Model unavailable");
		});
		await runApiTurn(
			{} as WorkspaceMachines,
			rootTurn("00000000-0000-4000-8000-0000000000f3"),
			{ index: 2, signal: new AbortController().signal },
		);
		expect(memory.prepareVm).not.toHaveBeenCalled();
		expect(memory.releaseVm).toHaveBeenCalledWith(undefined);
	});
});

describe("a builder's first request before its workspace is ready", () => {
	const rootTurn = {
		id: "turn-early",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Reply with ananab" }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Reply with ananab",
			},
		],
		lease_id: "lease",
	} as ApiTurn;
	const firstStep = () => ({ index: 1, signal: new AbortController().signal });
	const lean = {
		shape: "core",
		readOnly: false,
		commandReader: "read_command",
		waitHint: () => "",
		saveHistory: async () => null,
	};
	/** A workspace that becomes ready only when the test says so. */
	function heldWorkspace() {
		let ready = () => {};
		let fail = (_error: Error) => {};
		const held = new Promise((resolve, reject) => {
			ready = () => resolve({ machines: {}, vm: "vm", cwd: "/repo" });
			fail = reject;
		});
		held.catch(() => {});
		mocks.workspace.mockReturnValue(held);
		return { ready: () => ready(), fail: (error: Error) => fail(error) };
	}
	/** The chat's journaled configuration at its pinned baseline. */
	function knownHooks(events: string[]) {
		mocks.baseline.mockResolvedValue("a".repeat(40));
		mocks.hookConfig.mockResolvedValue({
			version: 1,
			hooks: events.map((event) => ({ event, command: "true" })),
		});
	}
	beforeEach(() => {
		mocks.lean = lean;
		knownHooks([]);
	});

	it("calls the model before the VM is ready, naming the path the chat reported", async () => {
		const workspace = heldWorkspace();
		mocks.preparedDirectory.mockResolvedValue("/repo");
		const order: string[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			order.push("model");
			expect(input.instructions).toContain("/repo");
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			setTimeout(() => {
				order.push("workspace");
				workspace.ready();
			}, 5);
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		// The step still ended on a prepared workspace: committed from it.
		expect(order).toEqual(["model", "workspace"]);
		expect(mocks.commit).toHaveBeenCalledOnce();
		expect(mocks.preparedDirectory).toHaveBeenCalledWith(
			"owner",
			"session",
			"project",
		);
	});

	it("logs one timing line per step, with why the first request went early or not", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const lines = () =>
				log.mock.calls
					.map(([line]) => String(line))
					.filter((line) => line.includes('"turn-timing"'))
					.map((line) => JSON.parse(line));
			const workspace = heldWorkspace();
			mocks.preparedDirectory.mockResolvedValue("/repo");
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				setTimeout(() => workspace.ready(), 5);
				return { messages: input.messages, outcome: "completed" };
			});
			await runApiTurn({} as WorkspaceMachines, rootTurn, {
				...firstStep(),
				startedAt: Date.now() - 50,
			});
			expect(lines()).toHaveLength(1);
			const [line] = lines();
			expect(line).toMatchObject({
				turn: "turn-early",
				step: 1,
				early: true,
				earlyReason: "early",
				outcome: "completed",
			});
			expect(line.phases.turnStart).toBeGreaterThanOrEqual(50);
			for (const phase of ["leaseAcquired", "settings", "firstToken", "end"])
				expect(line.phases[phase], phase).toBeTypeOf("number");
			// Ids, numbers and codes only: nothing from the prompt or reply.
			expect(JSON.stringify(line)).not.toMatch(/ananab|repo/);

			log.mockClear();
			mocks.workspace.mockResolvedValue({
				machines: {},
				vm: "vm",
				cwd: "/repo",
			});
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep());
			expect(lines()[0]).toMatchObject({
				early: false,
				earlyReason: "workspace-ready",
			});
		} finally {
			log.mockRestore();
		}
	});

	it("records the turn's code point while its attachments are still being restored", async () => {
		mocks.workspace.mockResolvedValue({ machines: {}, vm: "vm", cwd: "/repo" });
		const { ensureConversationCodePoint } = await import(
			"../services/conversation-recovery"
		);
		let restored = () => {};
		mocks.attachments.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					restored = resolve;
				}),
		);
		vi.mocked(ensureConversationCodePoint).mockImplementationOnce(async () => {
			// The repository capture starts before the files outside it are written.
			restored();
		});
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		expect(ensureConversationCodePoint).toHaveBeenCalledOnce();
		expect(mocks.attachments).toHaveBeenCalledOnce();
	});

	it("records the turn's code point while the checkout's baselines are still being set", async () => {
		const ready = { machines: {}, vm: "vm", cwd: "/repo" };
		let baselined = () => {};
		mocks.workspace.mockReturnValue(
			new Promise((resolve) => {
				baselined = () => resolve(ready);
			}),
		);
		mocks.checkedOut.mockReturnValue(Promise.resolve(ready));
		const { ensureConversationCodePoint } = await import(
			"../services/conversation-recovery"
		);
		vi.mocked(ensureConversationCodePoint).mockImplementationOnce(async () => {
			// The capture starts before the baselines finish; it never waits on them.
			baselined();
		});
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		expect(ensureConversationCodePoint).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			ready,
		);
	});

	describe("with memory on", () => {
		/** Memory whose clone finishes only when the test says so. */
		function heldClone() {
			let done = () => {};
			let cloned = false;
			const clone = new Promise<void>((resolve) => {
				done = () => {
					cloned = true;
					resolve();
				};
			});
			const order: string[] = [];
			const checkouts: string[] = [];
			const memory = {
				mode: "full",
				instructions: "",
				prepareVm: vi.fn(
					async (_workspace: unknown, beforeVm?: (token: string) => void) => {
						beforeVm?.("art_vm_token");
						await clone;
					},
				),
				vmTokens: () => ["art_vm_token"],
				releaseVm: vi.fn(async () => {
					order.push("release");
				}),
				attach: async (
					messages: unknown,
					_items: unknown,
					checkout: () => Promise<unknown>,
				) => {
					checkouts.push(
						await checkout().then(
							() => "read",
							() => "skipped",
						),
					);
					return { messages, recall: null };
				},
				recordSaved: async (items: unknown) => items,
				afterTurn: vi.fn(async () => {}),
			};
			mocks.turnMemory.mockResolvedValue(memory);
			return {
				memory,
				order,
				checkouts,
				done: () => {
					order.push("cloned");
					done();
				},
				cloned: () => cloned,
			};
		}

		it("calls the model without waiting for the ~/memory clone, its token already redacted", async () => {
			const clone = heldClone();
			mocks.stepRuntime.mockImplementation(async (input) => {
				expect(clone.cloned()).toBe(false);
				expect(mocks.hooksInput.current?.redact).toContain("art_vm_token");
				// Tools still wait for the clone; the guidance read does not.
				await input.tools.repositoryWorkspace();
				let toolReady = false;
				const tool = input.tools.workspace().then(() => {
					toolReady = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				expect(toolReady).toBe(false);
				clone.done();
				await tool;
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(clone.checkouts).toEqual(["read"]);
			expect(clone.order).toEqual(["cloned", "release"]);
		});

		it("releases the token only after a clone the step's tools never waited for", async () => {
			const clone = heldClone();
			mocks.stepRuntime.mockImplementation(async (input) => {
				setTimeout(() => clone.done(), 5);
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(clone.order).toEqual(["cloned", "release"]);
			expect(clone.memory.releaseVm).toHaveBeenCalledWith(
				expect.objectContaining({ vm: "vm" }),
			);
		});

		it("does not hold an early first request for the VM to mark missing paths", async () => {
			const clone = heldClone();
			clone.done();
			const workspace = heldWorkspace();
			mocks.preparedDirectory.mockResolvedValue("/repo");
			const order: string[] = [];
			mocks.stepRuntime.mockImplementation(async (input) => {
				order.push("model");
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				setTimeout(() => {
					order.push("workspace");
					workspace.ready();
				}, 5);
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(order).toEqual(["model", "workspace"]);
			expect(clone.checkouts).toEqual(["skipped"]);
		});

		it("marks missing paths from the checkout when the first request waits for it anyway", async () => {
			const clone = heldClone();
			clone.done();
			knownHooks(["UserPromptSubmit"]);
			mocks.preparedDirectory.mockResolvedValue("/repo");
			const workspace = heldWorkspace();
			setTimeout(() => workspace.ready(), 600);
			mocks.promptSubmit.mockResolvedValue({ block: false });
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(clone.checkouts).toEqual(["read"]);
		});
	});

	it("waits for the workspace as before when it is ready within the short wait", async () => {
		mocks.preparedDirectory.mockResolvedValue("/elsewhere");
		mocks.stepRuntime.mockImplementation(async (input) => {
			expect(input.instructions).toContain("/repo");
			expect(input.instructions).not.toContain("/elsewhere");
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		expect(mocks.preparedDirectory).not.toHaveBeenCalled();
	});

	it.each([
		["unknown (a new chat)", null],
		["a configured UserPromptSubmit hook", ["UserPromptSubmit"]],
	])(
		"waits for the workspace and the prompt check when the hook configuration is %s",
		async (_case, events) => {
			if (events) knownHooks(events);
			else {
				mocks.baseline.mockResolvedValue(null);
				mocks.hookConfig.mockResolvedValue(null);
			}
			mocks.preparedDirectory.mockResolvedValue("/repo");
			const workspace = heldWorkspace();
			const held = mocks.workspace();
			setTimeout(() => workspace.ready(), 600);
			// Like the real check, it needs the workspace.
			let checked = false;
			mocks.promptSubmit.mockImplementation(async () => {
				await held;
				checked = true;
				return { block: false };
			});
			mocks.stepRuntime.mockImplementation(async (input) => {
				// The prompt reached the model only after its check passed.
				expect(checked).toBe(true);
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
		},
	);

	describe("a new chat, from its project's configuration at the same commit", () => {
		const pinned = "b".repeat(40);
		const key = `lifecycle-hooks:/repo:${pinned}`;
		/** What other chats of the owner's project journaled, by key. */
		function projectHooks(
			journaled: Record<string, string[]>,
			scope = { userId: "owner", projectId: "project" },
		) {
			mocks.projectHookConfig.mockImplementation(
				async (userId, projectId, requested) => {
					const events =
						userId === scope.userId && projectId === scope.projectId
							? journaled[requested as string]
							: undefined;
					return events
						? {
								version: 1,
								hooks: events.map((event) => ({ event, command: "true" })),
							}
						: null;
				},
			);
		}
		beforeEach(() => {
			mocks.baseline.mockResolvedValue(null);
			mocks.hookConfig.mockResolvedValue(null);
			mocks.preparedDirectory.mockResolvedValue("/repo");
			mocks.pinnedBase.mockResolvedValue(pinned);
		});

		it("sends the first request early when that configuration has no UserPromptSubmit hook", async () => {
			projectHooks({ [key]: ["PreToolUse", "Stop"] });
			const workspace = heldWorkspace();
			const order: string[] = [];
			mocks.stepRuntime.mockImplementation(async (input) => {
				order.push("model");
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				setTimeout(() => {
					order.push("workspace");
					workspace.ready();
				}, 5);
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(order).toEqual(["model", "workspace"]);
			expect(mocks.projectHookConfig).toHaveBeenCalledWith(
				"owner",
				"project",
				key,
			);
		});

		it.each([
			[
				"the commit is not known before the workspace",
				() => {
					mocks.pinnedBase.mockResolvedValue(null);
					projectHooks({ [key]: [] });
				},
			],
			[
				"only another commit's configuration is known",
				() => projectHooks({ [`lifecycle-hooks:/repo:${"c".repeat(40)}`]: [] }),
			],
			[
				"that configuration has a UserPromptSubmit hook",
				() => projectHooks({ [key]: ["UserPromptSubmit"] }),
			],
			[
				"only another user's chats know it",
				() =>
					projectHooks(
						{ [key]: [] },
						{ userId: "other", projectId: "project" },
					),
			],
			[
				"only another project's chats know it",
				() =>
					projectHooks({ [key]: [] }, { userId: "owner", projectId: "other" }),
			],
		])(
			"waits for the workspace and the prompt check when %s",
			async (_case, arrange) => {
				arrange();
				const workspace = heldWorkspace();
				const held = mocks.workspace();
				setTimeout(() => workspace.ready(), 600);
				let checked = false;
				mocks.promptSubmit.mockImplementation(async () => {
					await held;
					checked = true;
					return { block: false };
				});
				mocks.stepRuntime.mockImplementation(async (input) => {
					expect(checked).toBe(true);
					await input.onEvent({
						type: "text-delta",
						id: "reply",
						text: "ananab",
					});
					return { messages: input.messages, outcome: "completed" };
				});
				expect(
					await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
				).toBe("completed");
			},
		);

		it.each([
			[
				"hook-config-no-pinned-base",
				() => {
					mocks.pinnedBase.mockResolvedValue(null);
				},
			],
			[
				"hook-config-unreadable",
				() => {
					projectHooks({});
					mocks.pinnedBaseFile.mockResolvedValue(null);
				},
			],
			[
				"hook-config-unjournaled",
				() => {
					mocks.baseline.mockResolvedValue("a".repeat(40));
					mocks.hookConfig.mockResolvedValue(null);
				},
			],
		])(
			"names why the configuration was unknown: %s",
			async (reason, arrange) => {
				arrange();
				const log = vi.spyOn(console, "log").mockImplementation(() => {});
				try {
					const workspace = heldWorkspace();
					setTimeout(() => workspace.ready(), 600);
					mocks.stepRuntime.mockImplementation(async (input) => {
						await input.onEvent({
							type: "text-delta",
							id: "reply",
							text: "ananab",
						});
						return { messages: input.messages, outcome: "completed" };
					});
					await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep());
					const line = log.mock.calls
						.map(([text]) => String(text))
						.find((text) => text.includes('"turn-timing"'));
					expect(JSON.parse(line as string)).toMatchObject({
						early: false,
						earlyReason: reason,
					});
				} finally {
					log.mockRestore();
				}
			},
		);

		const hookFile = (events: string[]) => ({
			present: true as const,
			text: JSON.stringify({
				version: 1,
				hooks: events.map((event) => ({ event, command: "true" })),
			}),
		});
		it.each([
			["has no hook file", { present: false as const }],
			["has a hook file without a UserPromptSubmit hook", hookFile(["Stop"])],
		])(
			"sends early when no chat read that commit yet and it %s on GitHub",
			async (_case, file) => {
				mocks.pinnedBaseFile.mockResolvedValue(file);
				const workspace = heldWorkspace();
				const order: string[] = [];
				mocks.stepRuntime.mockImplementation(async (input) => {
					order.push("model");
					await input.onEvent({
						type: "text-delta",
						id: "reply",
						text: "ananab",
					});
					setTimeout(() => {
						order.push("workspace");
						workspace.ready();
					}, 5);
					return { messages: input.messages, outcome: "completed" };
				});
				expect(
					await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
				).toBe("completed");
				expect(order).toEqual(["model", "workspace"]);
				expect(mocks.pinnedBaseFile).toHaveBeenCalledWith(
					pinned,
					".ytimesy/hooks.json",
				);
			},
		);

		it.each([
			["has a UserPromptSubmit hook", hookFile(["UserPromptSubmit"])],
			["cannot be read", null],
			["is not JSON", { present: true as const, text: "{" }],
			[
				"is not a valid configuration",
				{ present: true as const, text: '{"version":2,"hooks":[]}' },
			],
			[
				"is longer than the baseline read accepts",
				{
					present: true as const,
					text: `{"version":1,"hooks":[]}${" ".repeat(32000)}`,
				},
			],
		])(
			"waits for the workspace and the prompt check when the commit's file on GitHub %s",
			async (_case, file) => {
				mocks.pinnedBaseFile.mockResolvedValue(file);
				const workspace = heldWorkspace();
				const held = mocks.workspace();
				setTimeout(() => workspace.ready(), 600);
				let checked = false;
				mocks.promptSubmit.mockImplementation(async () => {
					await held;
					checked = true;
					return { block: false };
				});
				mocks.stepRuntime.mockImplementation(async (input) => {
					expect(checked).toBe(true);
					await input.onEvent({
						type: "text-delta",
						id: "reply",
						text: "ananab",
					});
					return { messages: input.messages, outcome: "completed" };
				});
				expect(
					await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
				).toBe("completed");
			},
		);

		it("prefers the project's journaled configuration over reading GitHub", async () => {
			projectHooks({ [key]: ["UserPromptSubmit"] });
			mocks.pinnedBaseFile.mockResolvedValue({ present: false });
			const workspace = heldWorkspace();
			const held = mocks.workspace();
			setTimeout(() => workspace.ready(), 600);
			let checked = false;
			mocks.promptSubmit.mockImplementation(async () => {
				await held;
				checked = true;
				return { block: false };
			});
			mocks.stepRuntime.mockImplementation(async (input) => {
				expect(checked).toBe(true);
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(mocks.pinnedBaseFile).not.toHaveBeenCalled();
		});

		it("keeps using the chat's own configuration once it has a baseline", async () => {
			knownHooks(["UserPromptSubmit"]);
			projectHooks({ [key]: [] });
			const workspace = heldWorkspace();
			const held = mocks.workspace();
			setTimeout(() => workspace.ready(), 600);
			let checked = false;
			mocks.promptSubmit.mockImplementation(async () => {
				await held;
				checked = true;
				return { block: false };
			});
			mocks.stepRuntime.mockImplementation(async (input) => {
				expect(checked).toBe(true);
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
			expect(mocks.projectHookConfig).not.toHaveBeenCalled();
		});
	});

	it("waits for the workspace when no chat of the project reported a path", async () => {
		const workspace = heldWorkspace();
		let ready = false;
		setTimeout(() => {
			ready = true;
			workspace.ready();
		}, 600);
		mocks.stepRuntime.mockImplementation(async (input) => {
			expect(ready).toBe(true);
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
	});

	it("fails the turn at the workspace stage when the VM fails after the request went out", async () => {
		const workspace = heldWorkspace();
		mocks.preparedDirectory.mockResolvedValue("/repo");
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			workspace.fail(new Error("Workspace sizing did not complete."));
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("failed");
		expect(mocks.commit).not.toHaveBeenCalled();
		const items = mocks.finalize.mock.lastCall?.[2] as { kind: string }[];
		expect(items.some((item) => item.kind === "error")).toBe(true);
	});

	it("ends the turn with the refusal when the UserPromptSubmit check refuses it late", async () => {
		const workspace = heldWorkspace();
		mocks.preparedDirectory.mockResolvedValue("/repo");
		mocks.promptSubmit.mockResolvedValue({
			block: true,
			reason: "Name the ticket.",
		});
		mocks.stepRuntime.mockImplementation(async (input) => {
			workspace.ready();
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("failed");
		expect(mocks.stepRuntime).toHaveBeenCalledOnce();
		expect(JSON.stringify(mocks.finalize.mock.lastCall?.[2])).toContain(
			"Name the ticket.",
		);
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("is not used by a durable turn's later steps", async () => {
		mocks.preparedDirectory.mockResolvedValue("/repo");
		mocks.stepRuntime.mockImplementation(async (input) => ({
			messages: input.messages,
			outcome: "continue",
		}));
		mocks.workspace.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 450));
			return { machines: {}, vm: "vm", cwd: "/repo" };
		});
		await runApiTurn({} as WorkspaceMachines, rootTurn, {
			index: 2,
			signal: new AbortController().signal,
		});
		expect(mocks.preparedDirectory).not.toHaveBeenCalled();
	});
});
