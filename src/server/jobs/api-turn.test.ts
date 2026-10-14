import { beforeEach, expect, it, vi } from "vitest";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import { CoordinationFailure } from "#/domain/conversation-turn-control";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

// These cases cover the lead path; builder-direct (the default) has its own tests.
process.env.YTIMESY_ROOT_AGENT_MODE = "lead";

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
	saveAgentTaskResultAndEvent: mocks.result,
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("../adapters/server-peer-inbox", () => ({
	injectServerPeerMessages: vi.fn(),
}));
vi.mock("../adapters/api-usage-budget", () => ({ reserveApiTokens: vi.fn() }));
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
vi.mock("../services/api-command-scope", () => ({
	stopApiTurnCommands: mocks.stop,
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

it("loads project knowledge into the cloud model instructions without preparing a VM", async () => {
	mocks.runtime.mockImplementation(async (input) => {
		expect(input.instructions).toContain(
			"Branch selection is implemented in branch.ts",
		);
		expect(input.instructions).toContain("historical data");
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
	expect(mocks.knowledge).toHaveBeenCalledWith(
		expect.objectContaining({ userId: "owner", projectId: "project" }),
		"Fix branches",
	);
});

it("uses the same project knowledge and completion capture for Codex subscription turns", async () => {
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		expect(input.instructions).toContain(
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
	expect(mocks.runtime).not.toHaveBeenCalled();
	expect(mocks.report).toHaveBeenCalledOnce();
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

it("immediately queues a completed child's parent event", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
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
		expect(mocks.commit.mock.calls[0][0].providerRef).toBe("executor");
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
	"keeps the 30-step leader bound and admits builder step 31 (builder: %s)",
	async (builder) => {
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			...(builder
				? {
						parentSessionId: "parent",
						taskAccess: "read_write",
						taskPlacement: "fresh",
					}
				: {}),
		});
		mocks.stepRuntime.mockResolvedValue({ messages: [], outcome: "continue" });
		expect(
			await runApiTurn({} as WorkspaceMachines, childTurn, {
				index: 31,
				signal: new AbortController().signal,
			}),
		).toBe(builder ? "continue" : "failed");
		if (builder) expect(mocks.stepRuntime).toHaveBeenCalledOnce();
		else expect(mocks.stepRuntime).not.toHaveBeenCalled();
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

it.each([
	["planning", "enter_plan_mode", "Plan mode is still on"],
	["proposed", "planProposal", "replied to your proposed plan"],
])(
	"tells a %s agent it is still in plan mode on the durable turn's first step",
	async (_state, marker, notice) => {
		mocks.stepRuntime.mockImplementation(async (input) => ({
			messages: input.messages,
			outcome: "continue",
		}));
		const items =
			marker === "planProposal"
				? [{ kind: "planProposal", id: SessionItemId("plan"), plan: "Plan" }]
				: [
						{
							kind: "dynamicToolCall",
							id: SessionItemId("enter"),
							tool: marker,
							status: "completed",
						},
					];
		const turn = {
			...childTurn,
			items,
			messages: [{ role: "user", content: "Go" }],
		} as ApiTurn;
		for (const index of [1, 2])
			await runApiTurn({} as WorkspaceMachines, turn, {
				index,
				signal: new AbortController().signal,
			});
		const [first, second] = mocks.stepRuntime.mock.calls.map(([input]) =>
			JSON.stringify(input.messages),
		);
		expect(first).toContain(notice);
		expect(second).not.toContain(notice);
	},
);

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
