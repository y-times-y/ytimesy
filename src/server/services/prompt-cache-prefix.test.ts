import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import type { InstructionVariant } from "#/domain/harness-variant";
import { WorkspaceId } from "#/domain/ids";
import { INSTRUCTION_PROFILE_ADDITIONS } from "#/domain/instruction-profiles";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { nativeWebSearchTools } from "#/server/adapters/native-web-search";
import { agentTurnInstructions } from "./agent-turn-instructions";
import { apiAgentTools } from "./api-agent-tools";
import { builderToolSurface } from "./builder-shell-surface";
import { type ModelAgentRuntime, runModelAgentStep } from "./model-agent-loop";
import type { WorkspaceMachines } from "./workspace-machines";

// Provider prompt caches reuse a request's longest byte-identical prefix
// (instructions, tools, then input items). These tests rebuild each durable
// step's request the way the subscription route sends it and assert that every
// request starts with the previous request's bytes.

const session = {
	id: "00000000-0000-4000-8000-000000000001",
	userId: "owner",
	projectId: "00000000-0000-4000-8000-000000000002",
	workspaceId: "00000000-0000-4000-8000-000000000003",
	harness: "codex",
	providerRef: WorkspaceId("vm"),
	parentSessionId: null,
	title: "Chat",
	taskAccess: null,
} as unknown as AgentSessionRecord;

/** A new durable step builds fresh tool objects with its own call-id prefix. */
function stepSetup(step: number) {
	const machines = {} as unknown as WorkspaceMachines;
	const signal = new AbortController().signal;
	const workspace = async () => ({
		machines,
		vm: WorkspaceId("vm"),
		cwd: "/home/ubuntu/ytimesy",
	});
	const surface = builderToolSurface({
		variant: "lean",
		modelId: "gpt-6.1-sol",
		tools: apiAgentTools({
			machines,
			session,
			workspace,
			turnId: "turn",
			signal,
			writable: true,
			freeformPatch: true,
			toolCallPrefix: `step-${step}:`,
		}),
		lean: {
			workspace,
			sessionId: session.id,
			turnId: "turn",
			toolCallPrefix: `step-${step}:`,
			signal,
			installHelpers: async () => {},
		},
	});
	const tools: ToolSet = {
		...surface.tools,
		...nativeWebSearchTools("openai"),
	};
	return {
		tools,
		instructions: agentTurnInstructions({
			session,
			tools,
			plugins: [],
			projectKnowledge: null,
			leanShape: surface.lean?.shape,
			leanWorkingDirectory: "/home/ubuntu/ytimesy",
		}),
	};
}

class Captured extends Error {}

/** The serialized Responses request one durable step sends for this history. */
async function request(
	step: number,
	messages: ModelMessage[],
	instructionVariant?: InstructionVariant,
) {
	let body: Record<string, unknown> | undefined;
	const capture: typeof fetch = async (_url, init) => {
		body = JSON.parse(String(init?.body));
		throw new Captured();
	};
	const runtime: ModelAgentRuntime = {
		model: connectedLanguageModel(
			{
				provider: "openai",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				modelId: "gpt-6.1-sol",
				apiKey: "fixture",
			},
			capture,
		),
		contextWindow: 500_000,
		requestSettings: (instructions) => ({
			providerOptions: {
				openai: {
					instructions,
					store: false,
					promptCacheKey: "chat",
					reasoningEffort: "medium",
					reasoningSummary: "auto",
					parallelToolCalls: true,
				},
			},
		}),
	};
	const setup = stepSetup(step);
	await runModelAgentStep(
		{
			userId: "owner",
			modelId: "gpt-6.1-sol",
			toolSurface: "implementation",
			instructionVariant,
			instructions: setup.instructions,
			messages,
			tools: setup.tools,
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
		},
		runtime,
	).catch((error) => {
		if (!body) throw error;
	});
	if (!body) throw new Error("No request was captured.");
	return body;
}

/** The cacheable prompt in prefix order: instructions, tools, input items. */
function prompt(body: Record<string, unknown>) {
	return [
		JSON.stringify(body.instructions),
		JSON.stringify(body.tools),
		...(body.input as unknown[]).map((item) => JSON.stringify(item)),
	];
}

function expectPrefix(previous: string[], next: string[]) {
	expect(next.length).toBeGreaterThanOrEqual(previous.length);
	expect(next.slice(0, previous.length)).toEqual(previous);
}

const openai = (itemId: string, extra: Record<string, unknown> = {}) => ({
	openai: { itemId, ...extra },
});

/** One turn as the running step holds it: keys in the order the model and tools produced them. */
const firstTurn: ModelMessage[] = [
	{ role: "user", content: "Add a count_lines helper with a test." },
	{
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "",
				providerOptions: openai("rs_1", {
					reasoningEncryptedContent: "gAAAA-encrypted-1",
				}),
			},
			{
				type: "text",
				text: "Looking at the module first.",
				providerOptions: openai("msg_1", { phase: "commentary" }),
			},
			{
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "bash",
				input: { command: "sed -n 1,80p words.py", timeout: 30 },
				providerOptions: openai("fc_1"),
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "bash",
				output: {
					type: "json",
					value: { status: 0, stdout: "def count_words(text): ...", id: "c1" },
				},
				providerOptions: openai("fc_1"),
			},
		],
	},
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "call_2",
				toolName: "bash",
				input: { command: "python3 -m unittest", timeout: 120 },
				providerOptions: openai("fc_2"),
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_2",
				toolName: "bash",
				output: {
					type: "json",
					value: { status: 0, stdout: "OK", stderr: "", id: "c2" },
				},
				providerOptions: openai("fc_2"),
			},
		],
	},
	{
		role: "user",
		content:
			"Background command outcomes (execution data, not a new user request): []",
	},
	{
		role: "assistant",
		content: [
			{
				type: "text",
				text: "Added count_lines and its test; the suite passes.",
				providerOptions: openai("msg_2", { phase: "final_answer" }),
			},
		],
	},
];

/** The same turn read back from api_turn.messages (jsonb: keys by byte length, then bytewise). */
function fromJsonb(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(fromJsonb);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
			.map((key) => [key, fromJsonb((value as Record<string, unknown>)[key])]),
	);
}

describe("prompt-cache prefix stability", () => {
	it("starts every step's request with the previous step's bytes, with tools rebuilt per step", async () => {
		const steps = [1, 3, 5, 6].map((end) => firstTurn.slice(0, end));
		const prompts: string[][] = [];
		for (const [index, history] of steps.entries())
			prompts.push(prompt(await request(index + 1, history)));
		for (let index = 1; index < prompts.length; index++)
			expectPrefix(prompts[index - 1], prompts[index]);
	});

	it("sends the same bytes for a history read back from jsonb", async () => {
		const history = firstTurn.slice(0, 6);
		const reloaded = JSON.parse(
			JSON.stringify(fromJsonb(history)),
		) as ModelMessage[];
		// The fixture really is reordered by the round trip.
		expect(JSON.stringify(reloaded)).not.toBe(JSON.stringify(history));
		expect(prompt(await request(2, reloaded))).toEqual(
			prompt(await request(2, history)),
		);
	});

	it("keeps the previous turn's last request as the next turn's prefix after a reload", async () => {
		// The last step of turn one ran on the in-memory history; turn two
		// starts from the saved (jsonb) copy plus the new prompt with memory parts.
		const lastOfTurn = prompt(await request(4, firstTurn.slice(0, 6)));
		const nextTurn = [
			...(JSON.parse(JSON.stringify(fromJsonb(firstTurn))) as ModelMessage[]),
			{
				role: "user",
				content: [
					{ type: "text", text: "Now also count characters." },
					{
						type: "text",
						text: "<memory>\n- Prefers short replies\n</memory>",
					},
				],
			} as ModelMessage,
		];
		expectPrefix(lastOfTurn, prompt(await request(1, nextTurn)));
	});
});

describe("instruction profiles reach the request", () => {
	it("sends the variant's guidance and keeps it byte-stable across steps", async () => {
		const messages: ModelMessage[] = [{ role: "user", content: "Fix it." }];
		const baseline = String((await request(1, messages)).instructions);
		expect(baseline).toContain("Harness tool profile v13-lean (openai)");
		expect(baseline).not.toContain(
			INSTRUCTION_PROFILE_ADDITIONS["verify-hard"],
		);
		const first = String(
			(await request(1, messages, "verify-hard")).instructions,
		);
		const second = String(
			(await request(2, messages, "verify-hard")).instructions,
		);
		expect(first).toContain("v13-lean+verify-hard (openai)");
		expect(first).toContain(INSTRUCTION_PROFILE_ADDITIONS["verify-hard"]);
		expect(second).toBe(first);
		expect(String((await request(1, messages, "default")).instructions)).toBe(
			baseline,
		);
	});
});
