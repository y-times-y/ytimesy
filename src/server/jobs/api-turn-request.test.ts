import { beforeEach, expect, it, vi } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	type HarnessVariant,
} from "#/domain/harness-variant";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

/**
 * Offline reproduction of a hard-set turn's model request: a Codex
 * subscription route, an eval user with a harness variant, the lean surface,
 * a durable (edge) step. Everything from the variant to the HTTP body sent
 * to chatgpt.com/backend-api/codex/responses is the real code; only storage,
 * the VM and the network are faked. The provider answers 400 once the
 * request is captured, so no model runs.
 */

const checkout = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const { execFileSync } =
		require("node:child_process") as typeof import("node:child_process");
	const directory = mkdtempSync(join(tmpdir(), "api-turn-request-"));
	execFileSync("git", ["init", "-q", directory]);
	return directory;
});

const mocks = vi.hoisted(() => ({
	variant: vi.fn(),
	saved: vi.fn(),
	finalize: vi.fn(),
}));
vi.mock("../adapters/dev-eval-users", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/dev-eval-users")>()),
	devEvalUsersEnabled: () => true,
	harnessVariantForUser: async () => mocks.variant(),
	isDevEvalUser: async () => true,
}));
vi.mock("../adapters/model-request-log", () => ({
	saveModelRequest: mocks.saved,
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: async () => true,
	codexExternalTokens: async () => ({
		accessToken: "token",
		chatgptAccountId: "account",
	}),
}));
vi.mock("../services/review-loop", () => ({ createReviewLoop: () => null }));
vi.mock("../services/attempt-loop", () => ({ createAttemptLoop: () => null }));
vi.mock("../services/attempt-loop-deps", () => ({
	attemptLoopDeps: () => ({}),
	reviewLoopDeps: () => ({}),
}));
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
	completedAgentCommands: async () => [],
}));
vi.mock("../services/turn-commit", () => ({
	commitCompletedSessionTurn: vi.fn(),
}));
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: async () => null,
	recordCloudProjectReport: async () => undefined,
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: async () => true,
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: async () => undefined,
	publishApiTurnProgress: async () => undefined,
	apiTurnCancelRequested: async () => false,
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: async () => owner,
	agentSessionMetadataForOwner: async () => owner,
}));
vi.mock("../adapters/agent-delegation-context", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../adapters/agent-delegation-context")
	>()),
	hasDelegatedTasks: async () => false,
}));
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: vi.fn(),
}));
vi.mock("../adapters/agent-task-events", () => ({
	saveAgentTaskResultAndEvent: vi.fn(async () => "event"),
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: vi.fn(async () => "job") }));
vi.mock("../adapters/server-peer-inbox", () => ({
	injectServerPeerMessages: vi.fn(),
}));
vi.mock("../adapters/api-usage-budget", () => ({ reserveApiTokens: vi.fn() }));
vi.mock("../services/conversation-recovery", () => ({
	ensureConversationCodePoint: vi.fn(async () => {}),
}));
vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: vi.fn(async () => null),
}));
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
	// An empty local checkout stands in for the VM: the repository guidance
	// scan runs for real against it; every other command succeeds silently.
	deferredApiTurnWorkspace: () => async () => ({
		machines: {
			exec: async (_vm: unknown, command: string) => {
				if (!command.startsWith("python3 -c "))
					return { exitCode: 0, stdout: "", stderr: "" };
				const { spawnSync } = await import("node:child_process");
				const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
				return {
					exitCode: run.status ?? 1,
					stdout: run.stdout,
					stderr: run.stderr,
				};
			},
			readTextFile: async () => null,
			writeTextFile: async () => undefined,
		},
		vm: "vm",
		cwd: checkout,
	}),
}));
vi.mock("../services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

const owner = {
	id: "session",
	userId: "eval-user",
	projectId: "project",
	harness: "api",
	taskAccess: "read_write",
};

const MODEL = "gpt-6.1-sol";

function codexBackend(bodies: Record<string, unknown>[]): typeof fetch {
	return async (url, init) => {
		const path = String(url);
		if (path.includes("/codex/models"))
			return Response.json({
				models: [
					{
						slug: MODEL,
						supported_reasoning_levels: [{ effort: "medium" }],
						default_reasoning_level: "medium",
						context_window: 400_000,
					},
				],
			});
		if (path.endsWith("/codex/responses")) {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json(
				{ error: { message: "captured", type: "invalid_request_error" } },
				{ status: 400 },
			);
		}
		throw new Error(`Unexpected request ${path}`);
	};
}

async function sentRequest(variant: Partial<HarnessVariant>) {
	mocks.variant.mockReturnValue({ ...DEFAULT_HARNESS_VARIANT, ...variant });
	const bodies: Record<string, unknown>[] = [];
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "eval-user",
		connection_id: null,
		connection_revision: subscriptionTurnRevision("medium"),
		model_id: MODEL,
		state: "running",
		messages: [{ role: "user", content: "Fix the compaction bug in /app." }],
		items: [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Fix the compaction bug in /app.",
			},
		],
		lease_id: "lease",
	} as ApiTurn;
	await withCodexSubscriptionEgress(codexBackend(bodies), () =>
		runApiTurn({} as WorkspaceMachines, turn, {
			index: 1,
			signal: new AbortController().signal,
		}),
	);
	const body = bodies[0] as {
		instructions: string;
		tools: { type: string; name?: string; description?: string }[];
	};
	return {
		body,
		names: body.tools.map((tool) => tool.name ?? tool.type),
	};
}

beforeEach(() => {
	mocks.saved.mockReset().mockResolvedValue(undefined);
	mocks.finalize.mockReset().mockImplementation(async (_turn, state) => state);
});

it("sends run_code and the lean tools to the Codex subscription when codeMode=primary", async () => {
	const { body, names } = await sentRequest({ codeMode: "primary" });
	expect(names).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit", "run_code"]),
	);
	expect(names).not.toContain("exec_command");
	const runCode = body.tools.find((tool) => tool.name === "run_code");
	expect(runCode?.type).toBe("function");
	expect(body.instructions).toContain("run_code is your main tool");
	// The model loop's lean profile must not send batching back to bash.
	expect(body.instructions).not.toContain("Inspect with bash");
	// The recorder saw the same request the provider received.
	const [, record, saved] = mocks.saved.mock.calls[0];
	expect(record).toMatchObject({ turnId: "turn", step: 1, call: 0 });
	expect(record.tools).toEqual(names);
	expect(saved.instructions).toBe(body.instructions);
});

it("offers no run_code with code mode off", async () => {
	const { names } = await sentRequest({ codeMode: "off" });
	expect(names).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit"]),
	);
	expect(names).not.toContain("run_code");
});
