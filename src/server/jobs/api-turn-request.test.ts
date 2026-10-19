import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalWorkSuffix } from "#/domain/eval-prompt";
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
	/** What runApiTurn handed the model loop (tools with their executors). */
	agentInputs: [] as unknown[],
	/** How many ancestors a subagent owner has (its level). */
	level: 0,
	/** Runs inside the turn, before the model call (its tools are live then). */
	probe: null as
		| null
		| ((input: { tools: Record<string, unknown> }) => Promise<void>),
}));
// The real subscription agent, with its input recorded on the way through.
vi.mock("../services/codex-subscription-agent", async (importOriginal) => {
	const real =
		await importOriginal<
			typeof import("../services/codex-subscription-agent")
		>();
	return {
		runCodexSubscriptionAgent: async (
			input: Parameters<typeof real.runCodexSubscriptionAgent>[0],
		) => {
			mocks.agentInputs.push(input);
			await mocks.probe?.(input);
			return real.runCodexSubscriptionAgent(input);
		},
		runCodexSubscriptionAgentStep: async (
			input: Parameters<typeof real.runCodexSubscriptionAgentStep>[0],
		) => {
			mocks.agentInputs.push(input);
			await mocks.probe?.(input);
			return real.runCodexSubscriptionAgentStep(input);
		},
	};
});
vi.mock("../adapters/subagents", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/subagents")>()),
	subagentAncestors: async () =>
		Array.from({ length: mocks.level }, (_, index) => ({ id: `a${index}` })),
}));
// A subagent's per-step budget check reads the tree's usage from the database.
vi.mock("../services/subagent-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/subagent-runtime")>()),
	guardSubagentStep: async (input: { messages: unknown }) => input.messages,
}));
// run_code's run journal: every run is new (no database).
vi.mock("../adapters/agent-task-command-receipts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../adapters/agent-task-command-receipts")
	>()),
	claimAgentTaskCommand: async () => ({ kind: "claimed" }),
	completeAgentTaskCommand: async () => undefined,
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

const ROOT_OWNER = {
	id: "session",
	userId: "eval-user",
	projectId: "project",
	harness: "api",
	taskAccess: "read_write",
};
let owner: Record<string, unknown> = ROOT_OWNER;

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

async function sentRequest(
	variant: Partial<HarnessVariant>,
	options: { step?: number; text?: string } = {},
) {
	mocks.variant.mockReturnValue({ ...DEFAULT_HARNESS_VARIANT, ...variant });
	mocks.agentInputs.length = 0;
	const text = options.text ?? "Fix the compaction bug in /app.";
	const bodies: Record<string, unknown>[] = [];
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "eval-user",
		connection_id: null,
		connection_revision: subscriptionTurnRevision("medium"),
		model_id: MODEL,
		state: "running",
		messages: [{ role: "user", content: text }],
		items: [{ kind: "userMessage", id: SessionItemId("user"), text }],
		lease_id: "lease",
	} as ApiTurn;
	await withCodexSubscriptionEgress(codexBackend(bodies), () =>
		runApiTurn({} as WorkspaceMachines, turn, {
			index: options.step ?? 1,
			signal: new AbortController().signal,
		}),
	);
	const body = bodies[0] as {
		instructions: string;
		input: unknown;
		tools: { type: string; name?: string; description?: string }[];
	};
	if (!body)
		throw new Error(
			`No model request was sent: ${JSON.stringify(mocks.finalize.mock.calls.at(-1)?.slice(1))?.slice(0, 1500)}`,
		);
	return {
		body,
		names: body.tools.map((tool) => tool.name ?? tool.type),
		agent: mocks.agentInputs[0] as {
			tools: ToolSet;
			instructions: string;
			toolOrder?: () => readonly string[];
		},
	};
}

beforeEach(() => {
	owner = ROOT_OWNER;
	mocks.level = 0;
	mocks.probe = null;
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
	// Listed first, and named first in "Your tools:".
	expect(names[0]).toBe("run_code");
	expect(body.instructions).toContain(
		"Your tools: run_code runs programs that call bash, read, edit and write; bash runs shell commands;",
	);
	expect(body.tools.find((tool) => tool.name === "bash")?.description).toMatch(
		/Use it for one command, or a long-running or interactive process; for several known steps use run_code\.$/,
	);
	expect(body.instructions).toContain("run_code is your main tool");
	// The model loop's lean profile must not send batching back to bash.
	expect(body.instructions).not.toContain("Inspect with bash");
	// The recorder saw the same request the provider received.
	const [, record, saved] = mocks.saved.mock.calls[0];
	expect(record).toMatchObject({ turnId: "turn", step: 1, call: 0 });
	expect(record.tools).toEqual(names);
	expect(saved.instructions).toBe(body.instructions);
});

it("sends nothing in code mode primary that batches several steps into one shell command", async () => {
	const { body } = await sentRequest({ codeMode: "primary", subagents: "on" });
	const text = [
		body.instructions,
		...body.tools.map((tool) => tool.description ?? ""),
	].join("\n");
	expect(text).not.toMatch(
		/in one command|in the same command|one combined verification command|command or script|from bash when/,
	);
	expect(text).toContain(
		"cover any remaining ones in one run_code program running the checks (Promise.all where independent)",
	);
});

it("sends a byte-identical system prompt and tool list on every step", async () => {
	const variant = { codeMode: "primary", subagents: "on" } as const;
	const first = await sentRequest(variant, { step: 1 });
	const second = await sentRequest(variant, { step: 2 });
	const third = await sentRequest(variant, { step: 3 });
	expect(second.body.instructions).toBe(first.body.instructions);
	expect(JSON.stringify(second.body.tools)).toBe(
		JSON.stringify(first.body.tools),
	);
	expect(third.body.instructions).toBe(first.body.instructions);
	expect(JSON.stringify(third.body.tools)).toBe(
		JSON.stringify(first.body.tools),
	);
});

it("sends the eval suffix without child tasks or a ban on delegation when subagents are on", async () => {
	const suffix = evalWorkSuffix({
		where: "environment",
		done: "task",
		subagents: true,
	});
	const { body } = await sentRequest(
		{ codeMode: "primary", subagents: "on" },
		{ text: `Fix the compaction bug in /app.${suffix}` },
	);
	const sent = JSON.stringify(body);
	expect(sent).toContain(
		"Work in this environment: no plan proposal, commits, pull requests or publishing.",
	);
	expect(sent).not.toContain("child tasks");
	expect(sent).not.toMatch(/work directly/i);
	expect(body.instructions).toContain("delegating only as below");
});

it("offers no run_code with code mode off", async () => {
	const { names } = await sentRequest({ codeMode: "off" });
	expect(names).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit"]),
	);
	expect(names).not.toContain("run_code");
});

it("keeps run_code after the lean tools and bash's own description with code mode on", async () => {
	const { body, names } = await sentRequest({ codeMode: "on" });
	expect(names.indexOf("run_code")).toBeGreaterThan(names.indexOf("bash"));
	expect(body.instructions).toContain("Your tools: bash runs shell commands;");
	expect(
		body.tools.find((tool) => tool.name === "bash")?.description,
	).not.toContain("run_code");
});

/**
 * Tool names that exist on some surface. A prompt that names one its
 * surface does not offer sends the model after a tool that is not there.
 * Plain words that are also tool names (read, write, edit, bash, agent)
 * count only as `tools.<name>` or `<name>` in backticks.
 */
const KNOWN_TOOLS = [
	"run_code",
	"agent",
	"agent_send",
	"find_tools",
	"web_search",
	"request_project_secret",
	"enter_plan_mode",
	"propose_plan",
	"report_task_blocked",
	"execute_command",
	"continue_command",
	"stop_command",
	"apply_patch",
	"apply_patches",
	"view_image",
	"check_deliverable",
	"read_context_archive",
	"search_context_history",
	"search_tools",
	"read_task_capacity",
	"batch_read",
	"run_checks",
	"inspect_changes",
	"create_task",
	"read_repository_guidance",
	"read_environment_report",
	"replace_text",
	"compose_tools",
	"exec_command",
	"write_stdin",
	"run_shell_command",
	"read_file",
	"write_file",
	"grep_search",
	"search_mcp_tools",
	"call_mcp_tool",
	"browser_open",
	"browser_screenshot",
	"browser_inspect",
	"browser_execute",
	"read",
	"write",
	"edit",
	"bash",
];

function namedTools(text: string) {
	return KNOWN_TOOLS.filter((name) => {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const forms = name.includes("_")
			? [`(?<![\\w-])${escaped}(?![\\w-])`]
			: [`tools\\.${escaped}(?![\\w-])`, `\`${escaped}\``];
		return forms.some((form) => new RegExp(form).test(text));
	});
}

type Role = "builder" | "writer" | "researcher" | "reviewer" | "checker";

function ownerFor(role: Role) {
	if (role === "builder") return ROOT_OWNER;
	return {
		...ROOT_OWNER,
		id: `child-${role}`,
		parentSessionId: "session",
		agentRole: role,
		agentBudget: { steps: 75, minutes: 15, tokens: 1_000_000 },
		taskAccess: role === "writer" ? "read_write" : "read_only",
		taskPlacement: role === "writer" ? "fork" : "shared",
	};
}

describe("role surfaces: every advertised tool works, no prompt names an absent one", () => {
	const cases = (
		["builder", "writer", "researcher", "reviewer", "checker"] as const
	).flatMap((role) =>
		(role === "builder" ? [0] : [1, 3]).flatMap((level) =>
			(["off", "on", "primary"] as const).flatMap((codeMode) =>
				(["off", "on"] as const).map((subagents) => ({
					role,
					level,
					codeMode,
					subagents,
				})),
			),
		),
	);
	it.each(cases)(
		"$role at level $level, codeMode=$codeMode, subagents=$subagents",
		async ({ role, level, codeMode, subagents }) => {
			owner = ownerFor(role);
			mocks.level = level;
			// Inside run_code, the tools a program can call (probed while the turn runs).
			let callable: Set<string> | null = null;
			mocks.probe = async (input) => {
				const runCode = (input.tools as ToolSet).run_code;
				if (!runCode) return;
				const run = (await runCode.execute?.(
					{ code: "return Object.keys(tools);" } as never,
					{
						toolCallId: "probe",
						messages: [],
						abortSignal: new AbortController().signal,
						context: {},
					} as never,
				)) as { ok: boolean; result?: string; error?: string };
				expect(run.error).toBeUndefined();
				callable = new Set(JSON.parse(run.result as string) as string[]);
			};
			const { body, names, agent } = await sentRequest({ codeMode, subagents });
			const tools = agent.tools;
			const available = new Set(Object.keys(tools));
			// Every tool in the request has an executor (or runs at the provider).
			for (const name of names) {
				const definition = tools[name === "web_search" ? "web_search" : name];
				expect(
					definition,
					`${name} is offered without a definition`,
				).toBeDefined();
				if (definition?.type === "provider") continue;
				expect(typeof definition?.execute, `${name} has no executor`).toBe(
					"function",
				);
			}
			// Deferred tools the prompt lists are callable once loaded.
			const listed = [...body.instructions.matchAll(/^- ([a-z_]+): /gm)].map(
				(match) => match[1] as string,
			);
			for (const name of listed.filter((name) => KNOWN_TOOLS.includes(name)))
				expect(
					typeof tools[name]?.execute,
					`${name} is listed but not executable`,
				).toBe("function");
			// No instruction or tool description names a tool this surface lacks.
			const text = [
				body.instructions,
				...body.tools.map((tool) => tool.description ?? ""),
			].join("\n");
			for (const name of namedTools(text))
				expect(available, `the prompt names ${name}`).toContain(name);
			// find_tools is named only when the request offers it.
			if (namedTools(body.instructions).includes("find_tools"))
				expect(names).toContain("find_tools");
			// Inside run_code, every tool the prompt says to call from a program exists.
			if (available.has("run_code")) {
				if (!callable) throw new Error("run_code was not probed.");
				for (const match of text.matchAll(/tools\.([A-Za-z_]+)\(/g))
					if (match[1] !== "name")
						expect(callable, `run_code cannot call ${match[1]}`).toContain(
							match[1],
						);
				if (codeMode === "primary")
					for (const name of listed.filter((name) =>
						KNOWN_TOOLS.includes(name),
					))
						expect(callable, `run_code cannot call ${name}`).toContain(name);
			}
			// Delegation: the checker never, the deepest level never, others when on.
			const delegates =
				role !== "checker" &&
				level < 3 &&
				(role !== "builder" || subagents === "on");
			expect(available.has("agent")).toBe(delegates);
			expect(body.instructions.includes("Subagents:")).toBe(delegates);
			// Readers share the parent's VM read-only: nothing that changes files.
			if (role !== "builder" && role !== "writer")
				for (const name of ["write", "edit"])
					expect(available.has(name), `a ${role} has ${name}`).toBe(false);
			if (role === "checker") {
				expect(available.has("agent_send")).toBe(false);
				expect(body.instructions).not.toContain("delegat");
			}
		},
	);
});
