// Live check of Y²'s model choice with a real model: Y²'s real instructions
// and its REAL tools (ySquaredTools, with the real input schemas converted the
// way the API route converts them), the person's models and threads faked.
//
//   ANTHROPIC_API_KEY=... node --import tsx scripts/y-squared-model-choice-check.ts [--runs 3]

import { asSchema } from "ai";
import { ySquaredInstructions } from "../src/domain/y-squared";
import type { ThreadModel } from "../src/domain/y-squared-models";
import { ySquaredTools } from "../src/server/services/y-squared-tools";

const API = "https://api.anthropic.com/v1/messages";
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] || "3");
const model = "claude-opus-5-5";
type Json = Record<string, unknown>;
type Block = Json & { type: string };

const m = (patch: Partial<ThreadModel> & { id: string; label: string }) =>
	({
		harness: "api",
		route: "Claude Agent (Claude plan)",
		tier: null,
		reasoning: [],
		speeds: [],
		usable: true,
		...patch,
	}) satisfies ThreadModel;
const MODELS: ThreadModel[] = [
	m({
		id: "gpt-6.2-sol",
		label: "GPT-6.2 Sol",
		harness: "codex",
		route: "Codex (ChatGPT plan)",
		tier: "frontier",
		reasoning: ["low", "medium", "high"],
		usable: false,
	}),
	m({
		id: "gpt-6-luna",
		label: "GPT-6 Luna",
		harness: "codex",
		route: "Codex (ChatGPT plan)",
		tier: "fast",
		speeds: ["fast"],
	}),
	m({
		id: "claude-code/claude-opus-5-5",
		label: "Claude Opus 5.5",
		tier: "frontier",
		reasoning: ["low", "medium", "high"],
	}),
	m({
		id: "claude-code/claude-haiku-5-5",
		label: "Claude Haiku 5.5",
		tier: "fast",
	}),
];
MODELS[0] = {
	...MODELS[0],
	unavailable: "plan used up until 2026-11-25 03:40 UTC",
} as ThreadModel;

const sends: { scope: Json; input: Json }[] = [];
const changes: Json[] = [];
const chat = (id: string, title: string) => ({
	id,
	title,
	projectId: "p",
	parentSessionId: null,
	agentRole: null,
	harness: "codex",
	listedModelId: "gpt-6-luna",
	turnStatus: "idle",
});
const threads: Record<string, ReturnType<typeof chat>> = {
	t1: chat("t1", "Billing refactor"),
};

const makeTools = () =>
	ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		machines: {} as never,
		modelId: "gpt-6-luna",
		harnessId: "codex",
		turnId: "check",
		deps: {
			crew: () => null,
			list: (async () => []) as never,
			metadata: (async (_u: string, id: string) =>
				threads[id] ?? null) as never,
			models: async () => ({ enabled: true, failover: true, models: MODELS }),
			send: (async (_machines: unknown, scope: Json, input: Json) => {
				sends.push({ scope, input });
				return { turnStatus: "running", sessionId: `new-${sends.length}` };
			}) as never,
			setModel: async (change) => {
				changes.push(change as unknown as Json);
				return { found: true, lineWritten: true };
			},
			stop: (async () => ({ turnStatus: "idle" })) as never,
		},
	});
const schemaTools = makeTools();
const names = [
	"list_models",
	"start_thread",
	"set_thread_model",
	"thread",
	"threads",
	"message_thread",
];
const defs = await Promise.all(
	names.map(async (name) => ({
		name,
		description:
			(schemaTools[name] as { description?: string }).description ?? "",
		input_schema: await asSchema(schemaTools[name]?.inputSchema as never)
			.jsonSchema,
	})),
);

let spend = 0;
async function call(messages: Json[]) {
	const response = await fetch(API, {
		method: "POST",
		headers: {
			"x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
			"anthropic-version": "2026-10-21",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			max_tokens: 4000,
			system: ySquaredInstructions(),
			tools: defs,
			messages,
		}),
	});
	if (!response.ok)
		throw new Error(
			`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
		);
	const data = (await response.json()) as { content: Block[]; usage: Json };
	spend +=
		(Number(data.usage.input_tokens ?? 0) * 4 +
			Number(data.usage.output_tokens ?? 0) * 20) /
		1e6;
	return data.content;
}

async function turn(text: string) {
	sends.length = 0;
	changes.length = 0;
	// One tool set per turn: the starts cap is per Y² turn.
	const tools = makeTools();
	const messages: Json[] = [{ role: "user", content: text }];
	const results: { name: string; input: Json; output: string }[] = [];
	for (let step = 0; step < 6; step++) {
		const content = await call(messages);
		messages.push({ role: "assistant", content });
		const uses = content.filter((block) => block.type === "tool_use");
		if (!uses.length)
			return {
				results,
				sends: [...sends],
				changes: [...changes],
				reply: content
					.filter((b) => b.type === "text")
					.map((b) => String(b.text))
					.join(" "),
			};
		const answered = [];
		for (const use of uses) {
			const output = await (
				tools[String(use.name)] as {
					execute: (input: unknown, options: unknown) => Promise<unknown>;
				}
			).execute(use.input, { toolCallId: String(use.id), messages: [] });
			results.push({
				name: String(use.name),
				input: use.input as Json,
				output: String(output),
			});
			answered.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: String(output),
			});
		}
		messages.push({ role: "user", content: answered });
	}
	return {
		results,
		sends: [...sends],
		changes: [...changes],
		reply: "(no end)",
	};
}

type Check = { name: string; pass: boolean; detail: string };
const scenarios: { name: string; run: () => Promise<Check[]> }[] = [
	{
		name: "risky work gets a strong model",
		run: async () => {
			const r = await turn(
				"Start a thread to run the production database migration that drops the legacy orders columns. Write the brief yourself.",
			);
			const used = r.sends[0]?.input.modelId;
			return [
				{
					name: "starts exactly one thread",
					pass: r.sends.length === 1,
					detail: `${r.sends.length}`,
				},
				{
					name: "on a frontier model that is usable",
					pass: used === "claude-code/claude-opus-5-5",
					detail: String(used),
				},
				{
					name: "says the non-default choice",
					pass: /opus/i.test(r.reply),
					detail: r.reply.slice(0, 100),
				},
			];
		},
	},
	{
		name: "a read-only lookup stays cheap",
		run: async () => {
			const r = await turn(
				"Start a thread to find out which module owns the invoice PDF rendering. Read-only research, no changes.",
			);
			const used = r.sends[0]?.input.modelId;
			return [
				{
					name: "starts one thread",
					pass: r.sends.length === 1,
					detail: `${r.sends.length}`,
				},
				{
					name: "default or a fast model, never the strongest",
					pass:
						used === "gpt-6-luna" || used === "claude-code/claude-haiku-5-5",
					detail: String(used),
				},
			];
		},
	},
	{
		name: "the person's named model is used exactly",
		run: async () => {
			const r = await turn(
				"Start a thread to rewrite the README intro, and run it on Claude Opus 5.5.",
			);
			return [
				{
					name: "that model",
					pass: r.sends[0]?.input.modelId === "claude-code/claude-opus-5-5",
					detail: `${String(r.sends[0]?.input.modelId)} :: ${r.reply.slice(0, 120)}`,
				},
			];
		},
	},
	{
		name: "an unavailable model is reported, never swapped",
		run: async () => {
			const r = await turn(
				"Start a thread to tidy the changelog, on GPT-6.2 Sol.",
			);
			return [
				{
					name: "starts nothing on another model",
					pass: r.sends.length === 0,
					detail: JSON.stringify(r.sends.map((s) => s.input.modelId)),
				},
				{
					name: "tells the person why",
					pass: /used up|not usable|unavailable|limit|run out|can.t be used/i.test(
						r.reply,
					),
					detail: r.reply.slice(0, 120),
				},
			];
		},
	},
	{
		name: "switches an existing thread",
		run: async () => {
			const r = await turn(
				'Switch the "Billing refactor" thread (t1) to Claude Opus 5.5 with high reasoning.',
			);
			return [
				{
					name: "calls set_thread_model once",
					pass: r.changes.length === 1,
					detail: `${r.changes.length}`,
				},
				{
					name: "with the right model and reasoning",
					pass:
						r.changes[0]?.modelId === "claude-code/claude-opus-5-5" &&
						r.changes[0]?.variant === "high",
					detail: JSON.stringify(r.changes[0]),
				},
			];
		},
	},
	{
		name: "shows what can be run",
		run: async () => {
			const r = await turn("Which models can you put a thread on right now?");
			return [
				{
					name: "calls list_models",
					pass: r.results.some((c) => c.name === "list_models"),
					detail: JSON.stringify(r.results.map((c) => c.name)),
				},
				{
					name: "names the spent plan as unavailable",
					pass:
						/sol/i.test(r.reply) && /used up|not|unavailable/i.test(r.reply),
					detail: r.reply.slice(0, 160),
				},
			];
		},
	},
];

let chain: Promise<unknown> = Promise.resolve();
function scenarioQueue<T>(run: () => Promise<T>): Promise<T> {
	const next = chain.then(run, run);
	chain = next.catch(() => undefined);
	return next;
}
const tally = new Map<
	string,
	{ pass: number; total: number; misses: string[] }
>();
await Promise.all(
	scenarios.flatMap((scenario) =>
		Array.from({ length: runs }, async () => {
			// Sequential state (sends, changes) is per turn: run each turn alone.
			for (const check of await scenarioQueue(scenario.run)) {
				const key = `${scenario.name}: ${check.name}`;
				const entry = tally.get(key) ?? { pass: 0, total: 0, misses: [] };
				entry.total++;
				if (check.pass) entry.pass++;
				else entry.misses.push(check.detail);
				tally.set(key, entry);
			}
		}),
	),
);
let failed = false;
for (const [key, entry] of tally) {
	if (entry.pass !== entry.total) failed = true;
	console.log(
		`${entry.pass === entry.total ? "PASS" : "FAIL"} ${entry.pass}/${entry.total}  ${key}${entry.misses.length ? `  | ${entry.misses.join(" | ")}` : ""}`,
	);
}
console.log(
	`\nmodel ${model}, ${runs} run(s), estimated spend $${spend.toFixed(2)}`,
);
process.exit(failed ? 1 : 0);
