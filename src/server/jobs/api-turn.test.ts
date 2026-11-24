import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import { CoordinationFailure } from "#/domain/conversation-turn-control";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { loadModelConnection } from "../adapters/model-connections";
import { observePeerInbox } from "../adapters/peer-inbox-observation";
import { FIRST_REQUEST_WORKSPACE_WAIT_MS } from "../services/first-request-gate";
import { abortLiveTurn } from "../services/live-turn-abort";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	yMode: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
	attachments: vi.fn(async (..._args: unknown[]) => {}),
	renew: vi.fn(),
	replaceItem: vi.fn(async (..._args: unknown[]) => true),
	finalize: vi.fn(),
	stop: vi.fn(),
	runtime: vi.fn(),
	stepRuntime: vi.fn(),
	subscriptionStepRuntime: vi.fn(),
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
	/** The next message waiting in the chat, started at the turn's end. */
	startQueued: vi.fn(async (..._args: unknown[]) => false),
	/** The step's inbox read; a test may report a ready setup catch-up. */
	peerInbox: vi.fn(),
	/** Set by a test that needs the real tool set and shell surface. */
	realSurface: false,
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
	loadCloudProjectKnowledge: mocks.knowledge,
	recordCloudProjectReport: mocks.report,
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: mocks.renew,
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: mocks.checkpoint,
	publishApiTurnProgress: mocks.progress,
	apiTurnCancelRequested: mocks.cancelRequested,
	replaceSettledTurnItem: mocks.replaceItem,
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	agentSessionMetadataForOwner: mocks.owner,
	// The parent chain, walked through the same fake as each chat is read.
	agentSessionAncestorMetadata: async (
		userId: string,
		sessionId: string,
		limit: number,
	) => {
		const ancestors: { parentSessionId?: string | null }[] = [];
		let current = await mocks.owner(userId, sessionId);
		while (current?.parentSessionId && ancestors.length < limit) {
			const parent = await mocks.owner(userId, current.parentSessionId);
			if (!parent) break;
			ancestors.push(parent);
			current = parent;
		}
		return ancestors;
	},
	listSidebarAgentSessions: vi.fn(async () => []),
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.turnMemory.mockReset().mockResolvedValue(null);
	mocks.subagentMemory.mockReset().mockResolvedValue(null);
	mocks.variant.mockReset().mockReturnValue(undefined);
	mocks.yMode.mockReset().mockResolvedValue(null);
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
	mocks.startQueued.mockReset().mockResolvedValue(false);
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
		await editsFiles(input);
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

it("keeps a subagent's finished answer when the command stop cannot be confirmed", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
		agentRole: "researcher",
	});
	mocks.stepRuntime.mockImplementation(async (input) => {
		await input.tools.workspace();
		await editsFiles(input);
		await input.onEvent({ type: "text-delta", id: "reply", text: "Found it." });
		return { messages: input.messages, outcome: "completed" };
	});
	mocks.stop.mockRejectedValueOnce(new Error("Cancellation uncertain"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(
			await runApiTurn({} as WorkspaceMachines, childTurn, {
				index: 1,
				signal: new AbortController().signal,
			}),
		).toBe("completed");
	} finally {
		warn.mockRestore();
	}
	expect(mocks.stop).toHaveBeenCalledOnce();
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"completed",
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
// The real catch-up reads the database, then runs the install in the chat's VM.
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
	runCodexSubscriptionAgentStep: mocks.subscriptionStepRuntime,
}));
vi.mock("../services/api-agent-tools", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../services/api-agent-tools")>();
	return {
		apiAgentTools: (input: Parameters<typeof actual.apiAgentTools>[0]) =>
			mocks.realSurface
				? actual.apiAgentTools(input)
				: Object.fromEntries(
						Object.entries(input as Record<string, unknown>).filter(
							([, value]) => value !== undefined,
						),
					),
	};
});
// The mocked tool set carries probe fields; the shell filter has its own tests.
vi.mock("../services/builder-shell-surface", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../services/builder-shell-surface")>();
	return {
		...actual,
		builderToolSurface: (
			input: Parameters<typeof actual.builderToolSurface>[0],
		) =>
			mocks.realSurface
				? actual.builderToolSurface(input)
				: mocks.lean
					? { tools: input.tools, lean: mocks.lean }
					: { tools: input.tools },
	};
});
vi.mock("../services/api-command-scope", () => ({
	COMMAND_SCOPES_DIRECTORY: "/tmp/ytimesy-api-command-scopes",
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
	deferredApiTurnWorkspace: (machines: unknown) => {
		let prepared: Promise<unknown> | undefined;
		return Object.assign(
			() => {
				prepared ??= mocks.workspace(machines);
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
			await editsFiles(input);
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

	it("shows the answer as done first, then opens the pull request and links it live", async () => {
		codexOwner();
		answering();
		const order: string[] = [];
		mocks.finalize.mockImplementation(async (_turn, state) => {
			order.push("finalize");
			return state;
		});
		mocks.commit.mockResolvedValueOnce({
			publish: async () => {
				order.push("publish");
				return {
					publication: {
						branch: "ytimesy/fix-branches-abc123",
						pullRequestUrl: "https://github.com/owner/repo/pull/4",
						pullRequest: {
							number: 4,
							url: "https://github.com/owner/repo/pull/4",
							draft: true,
							created: true,
						},
					},
				};
			},
		});
		expect(await runApiTurn({} as WorkspaceMachines, subscriptionTurn())).toBe(
			"completed",
		);
		expect(order).toEqual(["finalize", "publish"]);
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"completed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "notice",
					id: "turn:pull-request",
					message: "Opening pull request…",
					pullRequest: expect.objectContaining({ state: "opening" }),
				}),
			]),
		);
		expect(mocks.replaceItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: "turn" }),
			"turn:pull-request",
			expect.objectContaining({
				message: "Opened draft PR #4",
				pullRequest: expect.objectContaining({
					state: "opened",
					url: "https://github.com/owner/repo/pull/4",
				}),
			}),
		);
	});

	it("replaces the opening item with why the push failed", async () => {
		codexOwner();
		answering();
		mocks.commit.mockResolvedValueOnce({
			publish: async () => ({
				failure: "Changes are committed in this chat but were not pushed.",
			}),
		});
		expect(await runApiTurn({} as WorkspaceMachines, subscriptionTurn())).toBe(
			"completed",
		);
		expect(mocks.replaceItem).toHaveBeenCalledWith(
			expect.anything(),
			"turn:pull-request",
			{
				kind: "notice",
				id: "turn:pull-request",
				message: "Changes are committed in this chat but were not pushed.",
			},
		);
	});

	it("finishes its publication when a heartbeat renewal fails after the turn was marked done", async () => {
		codexOwner();
		answering();
		let done = false;
		mocks.finalize.mockImplementation(async (_turn, state) => {
			done = true;
			return state;
		});
		// The row is no longer 'running' once finalized: renewals say so.
		mocks.renew.mockImplementation(async () => !done);
		let published = false;
		mocks.commit.mockImplementationOnce(
			async (_session, _items, _runtime, signal) => ({
				publish: async () => {
					// Long enough for several heartbeat ticks after finalize.
					await new Promise((resolve) => setTimeout(resolve, 2_500));
					// Like the real publish, a cut-off turn reports a failure.
					if (signal?.aborted)
						return { failure: "Turn ownership or cancellation state changed." };
					published = true;
					return {
						publication: {
							branch: "b",
							pullRequestUrl: "https://github.com/owner/repo/pull/4",
							pullRequest: {
								number: 4,
								url: "https://github.com/owner/repo/pull/4",
								draft: true,
								created: true,
							},
						},
					};
				},
			}),
		);
		expect(await runApiTurn({} as WorkspaceMachines, subscriptionTurn())).toBe(
			"completed",
		);
		expect(published).toBe(true);
		expect(mocks.replaceItem).toHaveBeenCalledWith(
			expect.anything(),
			"turn:pull-request",
			expect.objectContaining({ message: "Opened draft PR #4" }),
		);
		expect(mocks.replaceItem).not.toHaveBeenCalledWith(
			expect.anything(),
			"turn:pull-request",
			expect.objectContaining({
				message: expect.stringContaining("ownership"),
			}),
		);
	});

	it("publishes even when the step is aborted while the turn is being marked done", async () => {
		codexOwner();
		answering();
		let releasing = false;
		// Releasing the conversation is slow; a heartbeat renewal fails meanwhile
		// (the row is no longer ours to renew) and aborts the step.
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			if (action === "release") {
				releasing = true;
				await new Promise((resolve) => setTimeout(resolve, 1_600));
			}
			return true;
		});
		mocks.renew.mockImplementation(async () => !releasing);
		let published = false;
		mocks.commit.mockImplementationOnce(
			async (_session, _items, _runtime, signal) => ({
				publish: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1_000));
					if (signal?.aborted)
						return {
							failure: "Turn ownership or cancellation state changed.",
						};
					published = true;
					return {};
				},
			}),
		);
		await runApiTurn({} as WorkspaceMachines, subscriptionTurn());
		expect(published).toBe(true);
		expect(mocks.replaceItem).not.toHaveBeenCalledWith(
			expect.anything(),
			"turn:pull-request",
			expect.objectContaining({
				message: expect.stringContaining("ownership"),
			}),
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
		// One failed renewal is retried; the turn stops once failures last.
		await vi.advanceTimersByTimeAsync(1001);
		expect(mocks.finalize).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25_000);
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
			// A real outage: the room answers neither the renewal nor the take-back.
			if (action === "renew" || action === "resume")
				throw new CoordinationFailure(action, { kind: "http", status: 503 }, 2);
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
		// One failed renewal is ridden out (a deploy restarting the chat's
		// object); only failures lasting most of the 30 s lease stop the turn.
		await vi.advanceTimersByTimeAsync(10_001);
		expect(mocks.stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20_000);
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

it("rides out a coordination renewal that fails while the chat's object restarts (a deploy)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		let renewals = 0;
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			if (action === "renew" && ++renewals <= 2)
				throw new CoordinationFailure(
					"renew",
					{ kind: "http", status: 503 },
					3,
				);
			return true;
		});
		let finish = () => {};
		let abortedWhileRunning = false;
		mocks.runtime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await new Promise<void>((resolve) => {
				finish = resolve;
				input.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			abortedWhileRunning = input.signal.aborted;
			input.signal.throwIfAborted();
			return { messages: [], outcome: "completed" } as never;
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(renewals).toBeGreaterThanOrEqual(3);
		finish();
		await vi.advanceTimersByTimeAsync(1_000);
		await run;
		// The run was never stopped for its coordination lease.
		expect(abortedWhileRunning).toBe(false);
		expect(warn).not.toHaveBeenCalledWith(
			"Turn heartbeat failed",
			expect.anything(),
		);
		expect(warn).toHaveBeenCalledWith(
			"Turn coordination renewal failed; trying again.",
			expect.anything(),
		);
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});

it("stops a writer on lease conflict without retrying inference or publication", async () => {
	vi.useFakeTimers();
	try {
		// Another lease holds the chat: the room refuses the renewal and the
		// take-back alike.
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "renew" && action !== "resume",
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

it("keeps a healthy turn whose renewals time out for the whole grace window, when the database still says it owns its lease (2026-11-24)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const actions: string[] = [];
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			actions.push(action);
			// The edge's pool is starved: every renewal times out, the take-back works.
			if (action === "renew")
				throw new CoordinationFailure(
					"renew",
					{ kind: "transport", category: "timeout" },
					3,
				);
			return true;
		});
		let stopped = false;
		mocks.runtime.mockImplementation(async (input) => {
			let finished = false;
			await new Promise<void>((resolve) => {
				input.signal.addEventListener(
					"abort",
					() => {
						if (!finished) stopped = true;
						resolve();
					},
					{ once: true },
				);
				setTimeout(() => {
					finished = true;
					resolve();
				}, 45_000);
			});
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(46_000);
		await run;
		expect(actions).toContain("resume");
		expect(stopped).toBe(false);
		expect(
			JSON.stringify(mocks.finalize.mock.calls.map((call) => call[2])),
		).not.toContain("coordination failed");
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});

it("takes back a lapsed chat lease it still owns instead of stopping mid-work (2026-11-23)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const actions: string[] = [];
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			actions.push(action);
			return action !== "renew" || actions.includes("resume");
		});
		// Stopped while the model call still runs (cleanup after it is not).
		let aborted = false;
		mocks.runtime.mockImplementation(async (input) => {
			let finished = false;
			await new Promise<void>((resolve) => {
				input.signal.addEventListener(
					"abort",
					() => {
						if (!finished) aborted = true;
						resolve();
					},
					{ once: true },
				);
				setTimeout(() => {
					finished = true;
					resolve();
				}, 25_000);
			});
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(26_000);
		await run;
		expect(actions).toContain("resume");
		expect(aborted).toBe(false);
		expect(
			JSON.stringify(mocks.finalize.mock.calls.map((call) => call[2])),
		).not.toContain("lease was lost");
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
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
					// The raw cause is kept for the owner, never in the message.
					cause: "Error: private database detail",
				}),
			]),
		);
		const error = mocks.finalize.mock.calls[0]?.[2]?.find(
			(item: { kind: string }) => item.kind === "error",
		);
		expect(error?.message).not.toContain("private database detail");
	} finally {
		warn.mockRestore();
	}
});

it.each([
	["abort reason", "Durable Object reset because its code was updated."],
	["model cancellation", "Durable Object reset because its code was updated."],
	[
		"abort reason",
		"Durable Object's isolate exceeded its memory limit and was reset.",
	],
	[
		"model cancellation",
		"Durable Object's isolate exceeded its memory limit and was reset.",
	],
])(
	"resumes after a progress-write reset when the runtime reports %s (%s)",
	async (reported, resetMessage) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mocks.progress
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error(resetMessage));
			// Like the Claude Code route's poll loop: it never awaits the writer, it
			// only notices the aborted signal on its next poll.
			mocks.runtime.mockImplementation(async (input) => {
				await input.onEvent({ type: "text-delta", id: "reply", text: "First" });
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (reported === "model cancellation" && input.signal.aborted)
					throw new Error("Model run cancelled.");
				input.signal.throwIfAborted();
				return input.messages;
			});
			await expect(
				runApiTurn({} as WorkspaceMachines, childTurn),
			).rejects.toThrow(resetMessage);
			expect(mocks.finalize).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	},
);

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

it("distinguishes completion coordination failures from progress-save failures, logging only the redacted cause", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(async (action) => {
			if (action === "release")
				throw new DOMException(
					"coordinator at private host refused token=abc123",
					"TimeoutError",
				);
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
			cause: expect.stringContaining("token=[redacted]"),
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("abc123");
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
			await editsFiles(input);
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

/** The model edited a file: the turn has changes to commit. */
function editsFiles(input: {
	onEvent: (event: {
		type: "tool-call";
		id: string;
		name: string;
		input: unknown;
	}) => unknown;
}) {
	return input.onEvent({
		type: "tool-call",
		id: "edit",
		name: "apply_patch",
		input: {},
	});
}

it("cancels at once when Stop lands during a machine call that never answers", async () => {
	vi.useFakeTimers();
	try {
		mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
		mocks.cancelRequested.mockResolvedValue(true);
		const exec = vi.fn(() => new Promise(() => {}));
		// Preparing the workspace runs a guest command on a VM that is not answering.
		mocks.workspace.mockImplementation(
			(machines: Pick<WorkspaceMachines, "exec">) =>
				machines.exec("vm" as never, "guard", 30_000),
		);
		mocks.runtime.mockImplementation(async (input) => {
			await input.tools.workspace();
		});
		const outcome = runApiTurn(
			{ exec } as unknown as WorkspaceMachines,
			childTurn,
			{ index: 1, signal: new AbortController().signal },
		);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(exec).toHaveBeenCalledOnce();
		expect(await outcome).toBe("cancelled");
	} finally {
		vi.useRealTimers();
	}
});

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

it("stops a turn running here the moment Stop reaches it, before any heartbeat", async () => {
	vi.useFakeTimers();
	try {
		mocks.renew.mockResolvedValue(true);
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let reason: unknown;
		mocks.stepRuntime.mockImplementation((input: { signal: AbortSignal }) => {
			started();
			return hangUntilAborted(input).catch((error: unknown) => {
				reason = error;
				throw error;
			});
		});
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 1,
			signal: new AbortController().signal,
		});
		await running;
		// No timer runs: the heartbeat never gets a chance to notice the stop.
		expect(abortLiveTurn(childTurn.id)).toBe(true);
		expect(await outcome).toBe("cancelled");
		expect(reason).toBeInstanceOf(ApiTurnCancelled);
		// The stop is known; nothing re-reads it before settling.
		expect(mocks.cancelRequested).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"cancelled",
			expect.arrayContaining([
				expect.objectContaining({ kind: "notice", stopped: true }),
			]),
		);
		// The finished turn no longer answers a later Stop.
		expect(abortLiveTurn(childTurn.id)).toBe(false);
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
					message: expect.stringContaining("took longer than 14 minutes"),
				}),
			]),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "failed",
				summary: expect.stringContaining("took longer than 14 minutes"),
			}),
		);
	},
);

describe("a step's soft deadline", () => {
	it("ends a step still waiting on its model call and continues, without failing the turn", async () => {
		mocks.stepRuntime.mockImplementation(hangUntilAborted);
		const outcome = await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 3,
			signal: new AbortController().signal,
			softDeadlineAt: Date.now() + 20,
		});
		expect(outcome).toBe("continue");
		expect(mocks.checkpoint).toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("ends a sampling step when the user presses Send on a queued message, so the next step reads it", async () => {
		mocks.stepRuntime.mockImplementation(hangUntilAborted);
		mocks.renew.mockImplementation(async () => {
			observePeerInbox("session", Date.now(), true, true);
			return true;
		});
		const outcome = await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 3,
			signal: new AbortController().signal,
		});
		expect(outcome).toBe("continue");
		expect(mocks.checkpoint).toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	}, 10_000);

	it("does the same for Codex on a ChatGPT plan: Send on a queued message is not only for API keys", async () => {
		mocks.subscriptionStepRuntime.mockImplementation(hangUntilAborted);
		mocks.renew.mockImplementation(async () => {
			observePeerInbox("session", Date.now(), true, true);
			return true;
		});
		const outcome = await runApiTurn(
			{} as WorkspaceMachines,
			{
				...childTurn,
				connection_id: null,
				connection_revision: subscriptionTurnRevision("medium"),
			} as ApiTurn,
			{ index: 3, signal: new AbortController().signal },
		);
		expect(mocks.subscriptionStepRuntime).toHaveBeenCalled();
		expect(outcome).toBe("continue");
		expect(mocks.finalize).not.toHaveBeenCalled();
	}, 10_000);

	it("never stops a step once a tool has started, and the hard abort still fails it", async () => {
		mocks.stepRuntime.mockImplementation(
			(input: { signal: AbortSignal; onToolStart?: () => void }) => {
				input.onToolStart?.();
				return hangUntilAborted(input);
			},
		);
		const deadline = new AbortController();
		const outcome = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 3,
			signal: deadline.signal,
			softDeadlineAt: Date.now() + 20,
		});
		await vi.waitFor(() => expect(mocks.stepRuntime).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Past the soft deadline with a tool running: nothing was cut.
		expect(mocks.finalize).not.toHaveBeenCalled();
		deadline.abort(new DOMException("Step budget reached.", "TimeoutError"));
		expect(await outcome).toBe("failed");
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.anything(),
			"failed",
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: expect.stringContaining("took longer than 14 minutes"),
				}),
			]),
		);
	});
});

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

it("gives up acquiring a chat that stays held past a whole retirement and lease, and says nothing ran", async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "acquire",
		);
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(mocks.finalize).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(70_000);
		expect(await run).toBe("failed");
		expect(mocks.runtime).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.finalize.mock.calls[0]?.[2])).toContain(
			"Nothing ran and nothing was lost",
		);
	} finally {
		vi.useRealTimers();
	}
});

it("gives up after one lease period on a later step, whose lease is gone", async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(coordinateConversationTurn).mockImplementation(
			async (action) => action !== "acquire",
		);
		const run = runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 2,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(40_000);
		expect(await run).toBe("failed");
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
			await editsFiles(input);
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

	it("lead=fusion (leadTools=thin): Main gets delegation and inspection only, at leadEffort; full restores its surface", async () => {
		const seen: { tools: string[]; reasoning: unknown }[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			seen.push({
				tools: Object.keys(input.tools ?? {}).sort(),
				reasoning: input.reasoning,
			});
			return { messages: input.messages, outcome: "completed" };
		});
		mocks.lean = {
			shape: "core",
			readOnly: false,
			commandReader: "read_command",
			waitHint: () => "",
			saveHistory: async () => null,
		};
		const base = (await import("#/domain/harness-variant"))
			.DEFAULT_HARNESS_VARIANT;
		for (const leadTools of ["thin", "full"] as const) {
			mocks.variant.mockReturnValue({ ...base, lead: "fusion", leadTools });
			await runApiTurn(
				{} as WorkspaceMachines,
				{ ...rootTurn, id: `turn-lead-${leadTools}` },
				durable(),
			);
		}
		mocks.lean = null;
		const [thin, full] = seen;
		expect(thin?.tools).toEqual(
			expect.arrayContaining(["agent", "agent_send"]),
		);
		for (const name of ["write", "edit", "apply_patch", "run_code"])
			expect(thin?.tools).not.toContain(name);
		expect(full?.tools.length).toBeGreaterThan(thin?.tools.length ?? 0);
		expect(full?.tools).toEqual(
			expect.arrayContaining(["agent", "agent_send"]),
		);
	});

	it("y=on: the root chat is Y, with delegation and questions only, Y's prompt, and it still commits", async () => {
		const seen: { tools: string[]; instructions: string }[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			seen.push({
				tools: Object.keys(input.tools ?? {}).sort(),
				instructions: String(input.instructions),
			});
			// Y edits nothing itself: it answers, and the commit takes builders' patches.
			await input.onEvent({
				type: "text-delta",
				id: "reply",
				text: "Started builder 1.",
			});
			return { messages: input.messages, outcome: "completed" };
		});
		mocks.lean = {
			shape: "core",
			readOnly: false,
			commandReader: "read_command",
			waitHint: () => "",
			saveHistory: async () => null,
		};
		const base = (await import("#/domain/harness-variant"))
			.PRODUCT_HARNESS_VARIANT;
		mocks.variant.mockReturnValue({ ...base, y: "on" });
		await runApiTurn(
			{} as WorkspaceMachines,
			{ ...rootTurn, id: "turn-y" },
			durable(),
		);
		mocks.lean = null;
		const [y] = seen;
		expect(y?.tools).toEqual(expect.arrayContaining(["agent", "agent_send"]));
		for (const name of [
			"bash",
			"read",
			"write",
			"edit",
			"apply_patch",
			"run_code",
			"read_command",
			"execute_command",
			"update_plan",
			"web_fetch",
		])
			expect(y?.tools).not.toContain(name);
		expect(y?.instructions).toContain(
			"You are Y, the ytimesy agent for this thread",
		);
		expect(y?.instructions).not.toContain("You are the ytimesy coding agent");
		// Builders' patches land in Y's checkout, so Y's turn commits them.
		expect(mocks.commit).toHaveBeenCalled();
	});

	it("a Y project's pinned Y² chat: thread tools and questions only, Y²'s prompt, no machine and no commit", async () => {
		const seen: { tools: string[]; instructions: string }[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			seen.push({
				tools: Object.keys(input.tools ?? {}).sort(),
				instructions: String(input.instructions),
			});
			await input.onEvent({
				type: "text-delta",
				id: "reply",
				text: "Two threads are working.",
			});
			return { messages: input.messages, outcome: "completed" };
		});
		mocks.lean = {
			shape: "core",
			readOnly: false,
			commandReader: "read_command",
			waitHint: () => "",
			saveHistory: async () => null,
		};
		// The product's variant (y off) with the project's switch on.
		mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "session" });
		await runApiTurn(
			{} as WorkspaceMachines,
			{ ...rootTurn, id: "turn-y2" },
			durable(),
		);
		mocks.lean = null;
		const [y2] = seen;
		expect(y2?.tools).toEqual([
			"archive_thread",
			"ask_user",
			"message_thread",
			"read_canvas",
			"retry_thread",
			"schedule",
			"show_canvas",
			"start_thread",
			"stop_thread",
			"thread",
			"threads",
			"view_image",
		]);
		expect(y2?.instructions).toContain(
			"You are Y², the ytimesy agent above all",
		);
		// Its tools read only the database: no VM is copied, woken or checked out.
		expect(mocks.workspace).not.toHaveBeenCalled();
		expect(mocks.checkedOut).not.toHaveBeenCalled();
		expect(mocks.turnMemory).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("a Y² chat's first step never touches a workspace: hooks, memory, instructions, early request", async () => {
		mocks.stepRuntime.mockImplementation(async (input) => {
			// What the real runtime does around every model request.
			const prepared = await input.prepareMessages?.(input.messages);
			await input.restoreInstructions?.(prepared ?? input.messages);
			await input.afterTools?.(prepared ?? input.messages);
			await input.compactionSnapshot?.(
				prepared ?? input.messages,
				new AbortController().signal,
			);
			await input.onEvent({ type: "text-delta", id: "reply", text: "Hello." });
			return { messages: input.messages, outcome: "completed" };
		});
		mocks.realSurface = true;
		// The project's setup finished while Y² has no machine: its inbox read
		// still reports a ready catch-up (it must not wake a VM for it).
		mocks.peerInbox.mockImplementation(
			async (
				_id: string,
				history: unknown,
				_checkpoint: unknown,
				_delivered: unknown,
				onSetupCatchUp?: () => void,
			) => {
				onSetupCatchUp?.();
				return history;
			},
		);
		mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "session" });
		// The real UserPromptSubmit hook runs in the checkout: Y² has none.
		mocks.promptSubmit.mockResolvedValue(undefined);
		const machines = new Proxy({} as WorkspaceMachines, {
			get: (_target, name) => {
				throw new Error(`Y² touched machines.${String(name)}`);
			},
		});
		const outcome = await runApiTurn(
			machines,
			{ ...rootTurn, id: "turn-y2-first" },
			{ index: 1, signal: new AbortController().signal },
		);
		mocks.realSurface = false;
		expect(outcome).toBe("completed");
		expect(mocks.workspace).not.toHaveBeenCalled();
		expect(mocks.checkedOut).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("a Y project's ordinary chat is Y, though the user's variant has y off", async () => {
		const seen: string[][] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			seen.push(Object.keys(input.tools ?? {}).sort());
			return { messages: input.messages, outcome: "completed" };
		});
		mocks.lean = {
			shape: "core",
			readOnly: false,
			commandReader: "read_command",
			waitHint: () => "",
			saveHistory: async () => null,
		};
		mocks.yMode.mockResolvedValue({ enabled: true, ySquaredId: "another" });
		await runApiTurn(
			{} as WorkspaceMachines,
			{ ...rootTurn, id: "turn-y-project" },
			durable(),
		);
		mocks.lean = null;
		expect(seen[0]).toEqual(expect.arrayContaining(["agent", "agent_send"]));
		expect(seen[0]).not.toContain("edit");
		expect(seen[0]).not.toContain("threads");
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
			// An earlier step's edit: the kept attempt has changes to commit.
			{
				kind: "fileChange",
				id: SessionItemId("turn:step-1:edit"),
				status: "completed",
				changes: [],
			},
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

describe("a turn's end after its final answer", () => {
	const rootTurn = {
		id: "turn-end",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "hi" }],
		items: [{ kind: "userMessage", id: SessionItemId("user"), text: "hi" }],
		lease_id: "lease",
	} as ApiTurn;
	const firstStep = () => ({ index: 1, signal: new AbortController().signal });
	const savingShown = () =>
		mocks.progress.mock.calls.some(([, items]) =>
			(items as { savingChanges?: true }[]).some((item) => item.savingChanges),
		);

	it("ends a turn that only answered at its answer: no command fence, commit or saving state", async () => {
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "Hello." });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(savingShown()).toBe(false);
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.objectContaining({ id: "turn-end" }),
			"completed",
			expect.anything(),
		);
		// A message sent meanwhile starts now.
		expect(mocks.startQueued).toHaveBeenCalledOnce();
	});

	it("commits a turn with changes before it is done, saying so instead of running, and starts the next message only after its publication", async () => {
		const order: string[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.tools.workspace();
			await editsFiles(input);
			await input.onEvent({ type: "text-delta", id: "reply", text: "Done." });
			return { messages: input.messages, outcome: "completed" };
		});
		let committing = () => {};
		mocks.commit.mockImplementation(async () => {
			order.push("commit");
			// The answer is final: the chat shows "Saving changes…" meanwhile.
			await vi.waitFor(() => expect(savingShown()).toBe(true));
			await new Promise<void>((resolve) => {
				committing = resolve;
			});
			return {
				publish: async () => {
					order.push("publish");
					return {};
				},
			};
		});
		mocks.finalize.mockImplementation(async (_turn, state, items) => {
			order.push(state);
			// "Saving changes…" is gone once the turn is marked done.
			expect(
				(items as { savingChanges?: true }[]).some(
					(item) => item.savingChanges,
				),
			).toBe(false);
			return state;
		});
		mocks.startQueued.mockImplementation(async () => {
			order.push("next message");
			return true;
		});
		const outcome = runApiTurn({} as WorkspaceMachines, rootTurn, firstStep());
		await vi.waitFor(() => expect(order).toEqual(["commit"]));
		// Its commands are fenced before the commit, so none outlives it.
		expect(mocks.stop).toHaveBeenCalledOnce();
		committing();
		// A message sent while it saved is delivered after the publication; the
		// turn is not cancelled for it.
		expect(await outcome).toBe("completed");
		expect(order).toEqual(["commit", "completed", "publish", "next message"]);
	});

	it("still commits when the only change came from an earlier step of the turn", async () => {
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "Done." });
			return { messages: input.messages, outcome: "completed" };
		});
		await runApiTurn(
			{} as WorkspaceMachines,
			{
				...rootTurn,
				items: [
					...rootTurn.items,
					{
						kind: "commandExecution",
						id: SessionItemId("turn-end:step-1:run"),
						command: "touch file",
						cwd: "/repo",
						status: "completed",
						output: "",
						exitCode: 0,
					},
				],
			} as ApiTurn,
			{ index: 2, signal: new AbortController().signal },
		);
		expect(mocks.commit).toHaveBeenCalledOnce();
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
	/** The chat already has a VM (a follow-up message, not a new chat). */
	function withVm() {
		mocks.owner.mockResolvedValue({
			id: "session",
			userId: "owner",
			projectId: "project",
			harness: "api",
			taskAccess: "read_write",
			providerRef: "vm",
		});
	}

	it("sends a new chat's first request without the short wait for a VM it does not have yet", async () => {
		mocks.preparedDirectory.mockResolvedValue("/repo");
		const workspace = heldWorkspace();
		const started = Date.now();
		let sentAfter = Number.POSITIVE_INFINITY;
		mocks.stepRuntime.mockImplementation(async (input) => {
			sentAfter = Date.now() - started;
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			setTimeout(() => workspace.ready(), 5);
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
		).toBe("completed");
		expect(sentAfter).toBeLessThan(FIRST_REQUEST_WORKSPACE_WAIT_MS);
	});

	it("ends an answer-only turn at its answer without waiting for a slow workspace", async () => {
		vi.useFakeTimers();
		try {
			mocks.preparedDirectory.mockResolvedValue("/repo");
			heldWorkspace(); // never ready: the VM is not answering
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.onEvent({
					type: "text-delta",
					id: "reply",
					text: "ananab",
				});
				return { messages: input.messages, outcome: "completed" };
			});
			const outcome = runApiTurn(
				{} as WorkspaceMachines,
				rootTurn,
				firstStep(),
			);
			// Marked done right after the answer, before the workspace answers.
			await vi.advanceTimersByTimeAsync(100);
			expect(mocks.finalize).toHaveBeenCalledWith(
				expect.objectContaining({ id: "turn-early" }),
				"completed",
				expect.anything(),
			);
			expect(mocks.commit).not.toHaveBeenCalled();
			// The step itself lets the preparation finish, bounded.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await outcome).toBe("completed");
			expect(mocks.commit).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("calls the model before the VM is ready, naming the path the chat reported", async () => {
		const workspace = heldWorkspace();
		mocks.preparedDirectory.mockResolvedValue("/repo");
		const order: string[] = [];
		mocks.stepRuntime.mockImplementation(async (input) => {
			order.push("model");
			expect(input.instructions).toContain("/repo");
			await editsFiles(input);
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
			// A chat that already has its VM waits briefly for it.
			withVm();
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

	it("runs the turn without a code point when the capture fails, instead of refusing it", async () => {
		mocks.workspace.mockResolvedValue({ machines: {}, vm: "vm", cwd: "/repo" });
		const { ensureConversationCodePoint } = await import(
			"../services/conversation-recovery"
		);
		vi.mocked(ensureConversationCodePoint).mockImplementationOnce(async () => {
			throw new Error("Could not create the code recovery point");
		});
		mocks.stepRuntime.mockImplementation(async (input) => {
			await input.onEvent({ type: "text-delta", id: "reply", text: "ananab" });
			return { messages: input.messages, outcome: "completed" };
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				await runApiTurn({} as WorkspaceMachines, rootTurn, firstStep()),
			).toBe("completed");
		} finally {
			warn.mockRestore();
		}
		expect(ensureConversationCodePoint).toHaveBeenCalledOnce();
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
		withVm();
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
			await editsFiles(input);
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
			await editsFiles(input);
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

describe("goal mode (the model starts it)", () => {
	const rootTurn = {
		id: "turn-goal",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Build the whole thing" }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Build the whole thing",
			},
		],
		lease_id: "lease",
	} as ApiTurn;
	type GoalCall = (args: Record<string, unknown>) => Promise<string>;
	const goalCall = (tools: unknown) =>
		(tools as { goal: { execute: GoalCall } }).goal.execute;
	const complete = {
		op: "update",
		status: "complete",
		evidence: [{ requirement: "Build the whole thing", proof: "ran: ok" }],
	};

	it("sends a started goal back as the next durable step, with the audit notice", async () => {
		mocks.stepRuntime.mockImplementation(async (input) => {
			await goalCall(input.tools)({
				op: "start",
				objective: "Build the whole thing",
			});
			await input.onEvent({ type: "text-delta", id: "reply", text: "Done?" });
			return { messages: input.messages, outcome: "completed" };
		});
		const result = await runApiTurn({} as WorkspaceMachines, rootTurn, {
			index: 2,
			signal: new AbortController().signal,
		});
		expect(result).toBe("continue");
		expect(mocks.finalize).not.toHaveBeenCalled();
		const { checkpointApiTurn } = await import("../adapters/api-turns");
		const [, messages, items] = vi
			.mocked(checkpointApiTurn)
			.mock.calls.at(-1) as unknown as [unknown, unknown[], unknown[]];
		expect(messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: expect.stringContaining("The goal below is still active"),
			}),
		);
		expect(items).toContainEqual(
			expect.objectContaining({
				kind: "notice",
				goal: expect.objectContaining({
					state: expect.objectContaining({
						status: "active",
						continuations: 1,
					}),
				}),
			}),
		);
	});

	it("ends the turn once the model marks the goal complete", async () => {
		mocks.stepRuntime.mockImplementation(async (input) => {
			const goal = goalCall(input.tools);
			await goal({ op: "start", objective: "Build the whole thing" });
			await goal(complete);
			await input.onEvent({ type: "text-delta", id: "reply", text: "Done." });
			return { messages: input.messages, outcome: "completed" };
		});
		expect(
			await runApiTurn({} as WorkspaceMachines, rootTurn, {
				index: 2,
				signal: new AbortController().signal,
			}),
		).toBe("completed");
	});

	it("runs the continuation as the same turn's next attempt on the local worker", async () => {
		let calls = 0;
		mocks.runtime.mockImplementation(async (input) => {
			calls++;
			const goal = goalCall(input.tools);
			if (calls === 1)
				await goal({ op: "start", objective: "Build the whole thing" });
			else {
				expect(JSON.stringify(input.messages)).toContain(
					"The goal below is still active",
				);
				await goal(complete);
			}
			await input.onEvent({
				type: "text-delta",
				id: `reply-${calls}`,
				text: "Working.",
			});
		});
		expect(await runApiTurn({} as WorkspaceMachines, rootTurn)).toBe(
			"completed",
		);
		expect(calls).toBe(2);
	});
});

describe("a turn that cannot take its chat's lease at once (2026-11-23)", () => {
	const items = () =>
		JSON.stringify(mocks.finalize.mock.calls.map((call) => call[2]));
	// A model call that answers at once (other tests leave their own).
	beforeEach(() => {
		mocks.runtime.mockReset().mockResolvedValue(undefined);
	});

	it("waits past a retirement on its first step, then runs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			const grantedAt = Date.now() + 75_000;
			vi.mocked(coordinateConversationTurn).mockImplementation(
				async (action) => action !== "acquire" || Date.now() >= grantedAt,
			);
			const run = runApiTurn({} as WorkspaceMachines, childTurn);
			await vi.advanceTimersByTimeAsync(80_000);
			await run;
			expect(mocks.runtime).toHaveBeenCalledOnce();
			expect(items()).not.toContain("did not start");
			expect(items()).not.toContain("could not confirm");
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
		}
	});

	it("rides out the chat's coordinator restarting before the turn starts", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			let attempts = 0;
			vi.mocked(coordinateConversationTurn).mockImplementation(
				async (action) => {
					if (action === "acquire" && ++attempts <= 3)
						throw new CoordinationFailure(
							"acquire",
							{ kind: "http", status: 503 },
							1,
						);
					return true;
				},
			);
			const run = runApiTurn({} as WorkspaceMachines, childTurn);
			await vi.advanceTimersByTimeAsync(10_000);
			await run;
			expect(mocks.runtime).toHaveBeenCalledOnce();
			expect(items()).not.toContain("did not start");
			expect(items()).not.toContain("could not confirm");
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
		}
	});

	it("ends as stopped, not as an error, when it is stopped while waiting", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			vi.mocked(coordinateConversationTurn).mockImplementation(
				async (action) => action !== "acquire",
			);
			mocks.cancelRequested.mockResolvedValue(true);
			const run = runApiTurn({} as WorkspaceMachines, childTurn);
			await vi.advanceTimersByTimeAsync(110_000);
			expect(await run).toBe("cancelled");
			expect(mocks.runtime).not.toHaveBeenCalled();
			expect(items()).not.toContain('"kind":"error"');
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
		}
	});
});

describe("a deploy cutting a running step's connection (2026-11-23)", () => {
	const step = () => ({ index: 1, signal: new AbortController().signal });
	beforeEach(() => {
		mocks.runtime.mockReset();
		mocks.stepRuntime.mockReset();
	});

	it("resumes a step whose model call lost its connection, instead of failing the turn", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mocks.stepRuntime.mockRejectedValue(
				new Error("Network connection lost."),
			);
			await expect(
				runApiTurn({} as WorkspaceMachines, childTurn, step()),
			).rejects.toThrow("Network connection lost.");
			expect(mocks.finalize).not.toHaveBeenCalled();
			expect(JSON.stringify(warn.mock.calls)).toContain("turn.interrupted");
		} finally {
			warn.mockRestore();
		}
	});

	it("resumes a box step whose request to the edge was reset while preparing its machine", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reset = Object.assign(new Error("read ECONNRESET"), {
				code: "ECONNRESET",
			});
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.tools.workspace();
				return { messages: input.messages, outcome: "completed" };
			});
			mocks.workspace.mockRejectedValue(
				new TypeError("fetch failed", { cause: reset }),
			);
			await expect(
				runApiTurn({} as WorkspaceMachines, childTurn, step()),
			).rejects.toThrow("fetch failed");
			expect(mocks.finalize).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("retries a box step the edge answered 503 for its machine, instead of 'the model request failed'", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const refused = Object.assign(
				new Error("The edge refused the workspace request (unavailable)."),
				{ name: "TurnBoxVmRefused", status: 503, code: "unavailable" },
			);
			mocks.stepRuntime.mockImplementation(async (input) => {
				await input.tools.workspace();
				return { messages: input.messages, outcome: "completed" };
			});
			mocks.workspace.mockRejectedValue(refused);
			await expect(
				runApiTurn({} as WorkspaceMachines, childTurn, step()),
			).rejects.toThrow("unavailable");
			expect(mocks.finalize).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("still settles a turn outside a step (nothing would retry it)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mocks.runtime.mockRejectedValue(new Error("Network connection lost."));
			expect(await runApiTurn({} as WorkspaceMachines, childTurn)).toBe(
				"failed",
			);
		} finally {
			warn.mockRestore();
		}
	});
});
