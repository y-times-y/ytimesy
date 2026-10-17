import type { ModelMessage } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { ApiTurn } from "../adapters/api-turns";
import { clearTurnMemo } from "../services/turn-memo";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

// Counts the database queries and VM commands each durable model step costs
// before the model is called. Only turn bookkeeping is mocked; the context
// builders (delegation, reviews, secrets, hooks, MCP, plugins) run for real.
const state = vi.hoisted(() => ({
	queries: [] as string[],
	execs: [] as string[],
	writes: [] as string[],
	children: [] as Record<string, unknown>[],
	available: 4,
	seen: [] as ModelMessage[][],
}));
const stepRuntime = vi.hoisted(() => vi.fn());

vi.mock("../adapters/database", () => ({
	database: () => ({
		query: async (sql: string, parameters: unknown[] = []) => {
			state.queries.push(sql.replace(/\s+/g, " ").trim());
			if (String(parameters[2] ?? "").startsWith("verification-baseline:"))
				return {
					rows: [
						{
							response: {
								result: {
									type: "verification-baseline",
									directory: "/repo",
									base: "a".repeat(40),
								},
							},
						},
					],
				};
			if (sql.includes("select exists"))
				return { rows: [{ present: state.children.length > 0 }] };
			if (sql.includes("select id,title,task_state"))
				return { rows: state.children };
			if (sql.includes("with occupied"))
				return { rows: [{ available: state.available }] };
			return { rows: [] };
		},
	}),
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: vi.fn(async () => true),
	finalizeApiTurn: vi.fn(async (_turn, outcome) => outcome),
	checkpointApiTurn: vi.fn(async () => {}),
	publishApiTurnProgress: vi.fn(async () => {}),
	apiTurnCancelRequested: vi.fn(async () => false),
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: vi.fn(async () => ({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: null,
		taskAccess: null,
	})),
}));
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: vi.fn(async () => ({
		revision: "revision",
		provider: "other",
		baseUrl: "https://example.test/",
	})),
}));
vi.mock("../adapters/analytics", () => ({ captureServerAnalytics: vi.fn() }));
vi.mock("../services/conversation-recovery", () => ({
	ensureConversationCodePoint: vi.fn(async () => {}),
}));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: vi.fn(),
	runApiAgentStep: stepRuntime,
}));
// The repository-instruction scan has its own tests and budget.
vi.mock("../services/automatic-repository-context", () => ({
	automaticRepositoryContext: (input: { tools: unknown }) => ({
		tools: input.tools,
		prepare: async (history: ModelMessage[]) => history,
		afterTools: async (history: ModelMessage[]) => history,
		restoreInstructions: async (history: ModelMessage[]) => history,
	}),
}));
vi.mock("../services/api-agent-tools", () => ({
	apiAgentTools: (input: { workspace: () => Promise<unknown> }) => ({
		execute_command: {
			description: "probe",
			inputSchema: { jsonSchema: {} },
			execute: async () => {
				await input.workspace();
				// A finished command page, as the runtime's runner returns.
				return {
					id: "00000000-0000-4000-8000-000000000000",
					status: 0,
					stdout: "",
					start: 0,
					nextStart: null,
				};
			},
		},
	}),
}));

const machines = {
	exec: async (_vm: string, command: string) => {
		state.execs.push(command);
		// A baseline without lifecycle hook configuration.
		return { exitCode: command.includes("hooks.json") ? 91 : 0, stdout: "" };
	},
	writeTextFile: async (_vm: string, path: string) => {
		state.writes.push(path);
	},
};
vi.mock("../services/api-turn-workspace", () => ({
	deferredApiTurnWorkspace: () => async () => ({
		machines,
		vm: "vm",
		cwd: "/repo",
	}),
}));

const turn = {
	id: "turn",
	session_id: "session",
	user_id: "owner",
	connection_id: "connection",
	connection_revision: "revision",
	model_id: "model",
	state: "running",
	messages: [{ role: "user", content: "Fix the build" }],
	items: [
		{ kind: "userMessage", id: SessionItemId("user"), text: "Fix the build" },
	],
	lease_id: "lease",
} as ApiTurn;

beforeEach(() => {
	clearTurnMemo();
	state.queries = [];
	state.execs = [];
	state.writes = [];
	state.children = [];
	state.available = 4;
	state.seen = [];
	stepRuntime.mockReset().mockImplementation(async (input) => {
		const prepared = await input.prepareMessages(input.messages);
		state.seen.push(prepared);
		// The default (lean) surface runs commands through bash.
		await (input.tools.execute_command ?? input.tools.bash).execute(
			{ command: "true" },
			{ toolCallId: `call-${state.seen.length}`, messages: [] },
		);
		return { messages: prepared, outcome: "continue" };
	});
});

/** Runs durable steps 1..n and returns each step's queries and VM commands. */
async function steps(count: number) {
	const perStep: { queries: string[]; execs: number; writes: number }[] = [];
	let messages = turn.messages;
	for (let index = 1; index <= count; index++) {
		const before = {
			queries: state.queries.length,
			execs: state.execs.length,
			writes: state.writes.length,
		};
		expect(
			await runApiTurn(
				{} as WorkspaceMachines,
				{ ...turn, messages },
				{
					index,
					signal: new AbortController().signal,
				},
			),
		).toBe("continue");
		messages = state.seen.at(-1) ?? messages;
		perStep.push({
			queries: state.queries.slice(before.queries),
			execs: state.execs.length - before.execs,
			writes: state.writes.length - before.writes,
		});
	}
	return perStep;
}

it("loads turn-fixed context once and adds no delegation context to a chat without children", async () => {
	const perStep = await steps(3);
	console.info(
		"per-step context cost (queries, VM execs, VM writes):",
		perStep.map((step) => [step.queries.length, step.execs, step.writes]),
	);
	// Later steps only check the peer inbox; config, secrets, hooks and the
	// children check come from the turn's first step.
	for (const later of perStep.slice(1)) {
		expect(later.queries).toEqual([
			expect.stringContaining("from agent_peer_inbox"),
		]);
		expect(later.execs).toBe(0);
		expect(later.writes).toBe(0);
	}
	expect(
		perStep[0].queries.filter((sql) => sql.includes("parent_session_id=$2")),
	).toHaveLength(1);
	for (const prepared of state.seen)
		expect(JSON.stringify(prepared)).not.toContain("Current delegated tasks");
});

it("keeps the delegated-task snapshot for a parent without re-sending it for capacity changes", async () => {
	state.children = [
		{
			id: "child",
			title: "Fix tests",
			task_state: "working",
			turn_status: "running",
			task_review_state: "pending",
		},
	];
	const [first] = await steps(1);
	expect(JSON.stringify(state.seen[0])).toContain("Current delegated tasks");
	expect(first.queries.some((sql) => sql.includes("task_state='done'"))).toBe(
		true,
	);
	state.available = 1;
	await steps(1);
	const snapshots = (state.seen.at(-1) ?? []).filter(
		(message) =>
			typeof message.content === "string" &&
			message.content.startsWith("Current delegated tasks"),
	);
	expect(snapshots).toHaveLength(1);
});

it("reloads turn-fixed context when a restarted isolate resumes the turn", async () => {
	await steps(2);
	clearTurnMemo();
	const [resumed] = await steps(1);
	expect(resumed.queries.length).toBeGreaterThan(1);
	expect(resumed.execs).toBeGreaterThan(0);
	// The turn's own write, plus the lean surface's helper bundle (this fake
	// VM never reports it installed).
	expect(resumed.writes).toBe(2);
});
