// Live check of Y's behaviour (harness variant y=on) with a real model: Y's real
// instructions and tool descriptions, tool results simulated (no VMs, no
// builders run). It checks what Y decides, not what builders do.
//
//   ANTHROPIC_API_KEY=... node --import tsx scripts/y-behaviour-check.ts [--runs 3] [--model claude-opus-5-5]
import {
	Y_AGENT_TOOL_DESCRIPTION,
	Y_REPLY_WORDS,
	yInstructions,
} from "../src/domain/y-agent";

const API = "https://api.anthropic.com/v1/messages";
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const runs = Number(flag("runs", "3"));
const model = flag("model", "claude-opus-5-5");
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
let spend = 0;

type Json = Record<string, unknown>;
type Block = Json & { type: string };

const TOOLS = [
	{
		name: "agent",
		description: Y_AGENT_TOOL_DESCRIPTION,
		input_schema: {
			type: "object",
			properties: {
				role: {
					type: "string",
					enum: ["writer", "researcher", "reviewer", "checker"],
				},
				title: { type: "string" },
				brief: { type: "string" },
				wait: { type: "boolean" },
			},
			required: ["role", "title"],
		},
	},
	{
		name: "agent_send",
		description: "Steer or stop a running agent.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "string" },
				message: { type: "string" },
				stop: { type: "boolean" },
			},
			required: ["id"],
		},
	},
	{
		name: "ask_user",
		description:
			"Ask the user to choose between options when a decision is genuinely theirs. Ends your turn.",
		input_schema: {
			type: "object",
			properties: { questions: { type: "array", items: { type: "object" } } },
			required: ["questions"],
		},
	},
];

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
			max_tokens: 8000,
			system: yInstructions(),
			tools: TOOLS,
			messages,
		}),
	});
	if (!response.ok)
		throw new Error(
			`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
		);
	const data = (await response.json()) as { content: Block[]; usage: Json };
	const u = data.usage;
	spend +=
		(Number(u.input_tokens ?? 0) * PRICE.input +
			Number(u.output_tokens ?? 0) * PRICE.output +
			Number(u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
			Number(u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) /
		1e6;
	return data.content;
}

/** Runs Y until it ends its turn; simulated results for its tool calls. Returns its calls and final reply. */
async function turn(prompt: Json[], simulate: (call: Block) => string) {
	const messages = [...prompt];
	const calls: Block[] = [];
	for (let step = 0; step < 6; step++) {
		const content = await call(messages);
		messages.push({ role: "assistant", content });
		const uses = content.filter((block) => block.type === "tool_use");
		if (!uses.length) {
			const reply = content
				.filter((block) => block.type === "text")
				.map((block) => String(block.text))
				.join(" ");
			return { calls, reply, messages };
		}
		calls.push(...uses);
		if (uses.some((use) => use.name === "ask_user"))
			return { calls, reply: "", messages };
		messages.push({
			role: "user",
			content: uses.map((use) => ({
				type: "tool_result",
				tool_use_id: use.id,
				content: simulate(use),
			})),
		});
	}
	return { calls, reply: "(no end within 6 steps)", messages };
}

let next = 1;
const started = (use: Block) => {
	const input = use.input as Json;
	if (use.name !== "agent") return "ok";
	const id = String(next++);
	if (input.role === "researcher" && input.wait)
		return `[agent ${id} researcher finished · 6 steps · 1m] parseArgs in src/cli.ts (lines 10-48) reads process.argv with a hand-written loop; flags are --out and --quiet; unknown flags throw "unknown flag".`;
	return `Started agent ${id} (${input.role}) in the background; its report arrives as a message. Budget: 150 steps, 30 minutes.`;
};
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const user = (text: string) => ({ role: "user", content: text });

type Check = { name: string; pass: boolean; detail: string };
const scenarios: { name: string; run: () => Promise<Check[]> }[] = [
	{
		name: "one change",
		run: async () => {
			const r = await turn(
				[
					user(
						"Add a --verbose flag to the CLI that prints each file as it is processed.",
					),
				],
				started,
			);
			const writers = r.calls.filter(
				(c) => c.name === "agent" && (c.input as Json).role === "writer",
			);
			const brief = String(
				(writers[0]?.input as Json | undefined)?.brief ?? "",
			);
			return [
				{
					name: "starts a builder",
					pass: writers.length >= 1,
					detail: `${writers.length} writer(s)`,
				},
				{
					name: "brief says what done means",
					pass: /test|check|verify|run/i.test(brief),
					detail: brief.slice(0, 90),
				},
				{
					name: "does not wait or claim done",
					pass:
						!/\bdone\b|finished|completed/i.test(r.reply) ||
						/will|when/i.test(r.reply),
					detail: r.reply.slice(0, 90),
				},
				{
					name: `reply ≤ ${Y_REPLY_WORDS} words`,
					pass: words(r.reply) <= Y_REPLY_WORDS,
					detail: `${words(r.reply)} words`,
				},
			];
		},
	},
	{
		name: "question about the code",
		run: async () => {
			const r = await turn(
				[user("How does the CLI parse its flags today?")],
				started,
			);
			const readers = r.calls.filter(
				(c) => c.name === "agent" && (c.input as Json).role !== "writer",
			);
			const writers = r.calls.filter(
				(c) => c.name === "agent" && (c.input as Json).role === "writer",
			);
			return [
				{
					name: "asks a reader instead of guessing",
					pass: readers.length >= 1,
					detail: `${readers.length} reader(s)`,
				},
				{
					name: "starts no builder for a question",
					pass: writers.length === 0,
					detail: `${writers.length} writer(s)`,
				},
				{
					name: "answers from the reader's report",
					pass: /parseArgs|argv|--out|--quiet/.test(r.reply),
					detail: r.reply.slice(0, 90),
				},
				{
					name: `reply ≤ ${Y_REPLY_WORDS} words`,
					pass: words(r.reply) <= Y_REPLY_WORDS,
					detail: `${words(r.reply)} words`,
				},
			];
		},
	},
	{
		name: "two independent changes",
		run: async () => {
			const r = await turn(
				[
					user(
						"Two things: fix the typo 'recieve' in README.md, and add a /health endpoint to the API server in server/app.ts that returns 200 ok.",
					),
				],
				started,
			);
			const writers = r.calls.filter(
				(c) => c.name === "agent" && (c.input as Json).role === "writer",
			);
			return [
				{
					name: "starts two builders",
					pass: writers.length === 2,
					detail: `${writers.length} writer(s)`,
				},
				{
					name: `reply ≤ ${Y_REPLY_WORDS} words`,
					pass: words(r.reply) <= Y_REPLY_WORDS,
					detail: `${words(r.reply)} words`,
				},
			];
		},
	},
	{
		name: "a builder reports back",
		run: async () => {
			const first = await turn(
				[
					user(
						"Add a --verbose flag to the CLI that prints each file as it is processed.",
					),
				],
				started,
			);
			const report = user(
				"[agent 1 writer finished · 22 steps · 4m] Added --verbose to src/cli.ts; each file path is printed before processing. Added tests in test/cli.test.ts; `npm test` passed (41 tests).\nBuilder 1's changes (2 files, +38 −2) were applied to this thread's checkout; they are committed and published when your turn ends.",
			);
			const r = await turn([...first.messages, report], started);
			// A reader checking the builder's work is allowed; a new builder is not.
			const newAgents = r.calls.filter(
				(c) => c.name === "agent" && (c.input as Json).role === "writer",
			);
			if (process.env.Y_DEBUG)
				console.log(
					"AFTER REPORT:",
					JSON.stringify(newAgents.map((c) => c.input)).slice(0, 600),
					"| REPLY:",
					r.reply.slice(0, 700),
				);
			return [
				{
					name: "tells the person it is done",
					pass: /verbose/i.test(r.reply) && /test|pass/i.test(r.reply),
					detail: r.reply.slice(0, 90),
				},
				{
					name: "starts no new builder",
					pass: newAgents.length === 0,
					detail: `${newAgents.length} writer(s)`,
				},
				{
					name: `reply ≤ ${Y_REPLY_WORDS} words`,
					pass: words(r.reply) <= Y_REPLY_WORDS,
					detail: `${words(r.reply)} words`,
				},
			];
		},
	},
];

const tally = new Map<
	string,
	{ pass: number; total: number; details: string[] }
>();
await Promise.all(
	scenarios.flatMap((scenario) =>
		Array.from({ length: runs }, async () => {
			for (const check of await scenario.run()) {
				const key = `${scenario.name}: ${check.name}`;
				const entry = tally.get(key) ?? { pass: 0, total: 0, details: [] };
				entry.total++;
				if (check.pass) entry.pass++;
				else entry.details.push(check.detail);
				tally.set(key, entry);
			}
		}),
	),
);
for (const scenario of scenarios)
	for (const [key, entry] of tally)
		if (key.startsWith(`${scenario.name}:`))
			console.log(
				`${entry.pass === entry.total ? "PASS" : "FAIL"} ${entry.pass}/${entry.total}  ${key}${entry.details.length ? `  | ${entry.details.join(" | ")}` : ""}`,
			);
console.log(
	`\nmodel ${model}, ${runs} run(s) per scenario, estimated spend $${spend.toFixed(2)}`,
);
