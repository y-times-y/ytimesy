// Live check of Y²'s behaviour with a real model: Y²'s real instructions and
// tools, the tools answered from a fixed project (no database, no VMs).
//
//   ANTHROPIC_API_KEY=... node --import tsx scripts/y-squared-behaviour-check.ts [--runs 5]

import {
	threadDigest,
	threadsOverview,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_THREADS_TOOL,
	ySquaredInstructions,
} from "../src/domain/y-squared";
import { crewWakeBody } from "../src/domain/y-squared-crew";

const API = "https://api.anthropic.com/v1/messages";
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] || "5");
const model = "claude-opus-5-5";
let spend = 0;
type Json = Record<string, unknown>;
type Block = Json & { type: string };

const NOW = Date.parse("2026-11-12T12:00:00Z");
const threads = [
	{
		id: "t1",
		title: "Verbose flag",
		waitingOn: "question" as const,
		workingSince: null,
		reply: "Should --verbose print to stderr or stdout?",
	},
	{
		id: "t2",
		title: "Health endpoint",
		waitingOn: null,
		workingSince: "2026-11-12T11:48:00Z",
		reply: "Builder 1 is adding /health; I'll report when its tests pass.",
	},
	{
		id: "t3",
		title: "README typo",
		waitingOn: null,
		workingSince: null,
		reply: "Fixed 'recieve' in README.md.",
		pr: "#41 https://github.com/o/r/pull/41",
	},
	{
		id: "t4",
		title: "Flaky login test",
		waitingOn: "failed" as const,
		workingSince: null,
		reply: "The builder could not reproduce the failure.",
	},
];
const overview = threadsOverview(
	threads.map((thread) =>
		threadDigest({
			id: thread.id,
			title: thread.title,
			waitingOn: thread.waitingOn,
			workingSince: thread.workingSince,
			updatedAt: "2026-11-12T11:00:00Z",
			now: NOW,
			items: [
				{ kind: "agentMessage", id: `${thread.id}:a`, text: thread.reply },
				...(thread.pr
					? [
							{
								kind: "notice",
								id: `${thread.id}:p`,
								message: "",
								pullRequest: {
									state: "opened",
									number: 41,
									url: "https://github.com/o/r/pull/41",
									draft: true,
									created: true,
								},
							},
						]
					: []),
			] as never,
		}),
	),
);

const TOOLS = [
	{
		name: Y_SQUARED_THREADS_TOOL,
		description:
			"Every thread in this project: what it needs from the person, whether it is working, its last request and reply, and its pull request. Threads that need the person come first.",
		input_schema: { type: "object", properties: {} },
	},
	{
		name: Y_SQUARED_THREAD_TOOL,
		description:
			"One thread's details: its status, its recent requests and replies, and its pull request. Pass the id from the threads list.",
		input_schema: {
			type: "object",
			properties: { id: { type: "string" } },
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
			system: ySquaredInstructions(),
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
		(Number(u.input_tokens ?? 0) * 4 +
			Number(u.output_tokens ?? 0) * 20 +
			Number(u.cache_creation_input_tokens ?? 0) * 5 +
			Number(u.cache_read_input_tokens ?? 0) * 0.2) /
		1e6;
	return data.content;
}

async function turn(text: string) {
	const messages: Json[] = [{ role: "user", content: text }];
	const calls: Block[] = [];
	for (let step = 0; step < 6; step++) {
		const content = await call(messages);
		messages.push({ role: "assistant", content });
		const uses = content.filter((block) => block.type === "tool_use");
		if (!uses.length)
			return {
				calls,
				reply: content
					.filter((b) => b.type === "text")
					.map((b) => String(b.text))
					.join(" "),
			};
		calls.push(...uses);
		messages.push({
			role: "user",
			content: uses.map((use) => ({
				type: "tool_result",
				tool_use_id: use.id,
				content:
					use.name === Y_SQUARED_THREADS_TOOL
						? overview
						: use.name === Y_SQUARED_THREAD_TOOL
							? `"Flaky login test" (id t4)\nStatus: it failed on its last turn\nRecent:\nperson: The login test fails about once in five CI runs; fix it.\nY: Started builder 1.\nY: The builder could not reproduce the failure in 30 runs.`
							: "ok",
			})),
		});
	}
	return { calls, reply: "(no end)" };
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
type Check = { name: string; pass: boolean; detail: string };
const scenarios: { name: string; run: () => Promise<Check[]> }[] = [
	{
		name: "what is going on",
		run: async () => {
			const r = await turn("What's going on in this project?");
			const first = r.calls[0];
			const verbose = r.reply.indexOf("Verbose");
			const typo = r.reply.search(/README|typo/i);
			return [
				{
					name: "reads the threads first",
					pass: first?.name === Y_SQUARED_THREADS_TOOL,
					detail: String(first?.name),
				},
				{
					name: "leads with what needs the person",
					pass: verbose >= 0 && (typo < 0 || verbose < typo),
					detail: r.reply.slice(0, 80),
				},
				{
					name: "mentions the failed thread",
					pass: /flaky|login/i.test(r.reply),
					detail: r.reply.slice(0, 80),
				},
				{
					name: "gives the pull request",
					pass: /#41|pull\/41/.test(r.reply),
					detail: r.reply.slice(0, 80),
				},
				{
					name: "≤ 150 words",
					pass: words(r.reply) <= 150,
					detail: `${words(r.reply)} words`,
				},
			];
		},
	},
	{
		name: "busy wake",
		run: async () => {
			const r = await turn(
				crewWakeBody({
					events: [
						{
							kind: "waiting",
							title: "Verbose flag",
							detail: "asked a question",
						},
						{ kind: "failed", title: "Flaky login test" },
						{ kind: "finished", title: "README typo", detail: "PR #41" },
					] as never,
					working: [{ title: "Health endpoint", since: NOW - 12 * 60_000 }],
					now: NOW,
				}),
			);
			return [
				{
					name: "≤ 70 words",
					pass: words(r.reply) <= 70,
					detail: `${words(r.reply)} words`,
				},
				{
					name: "no table",
					pass: !r.reply.includes("|"),
					detail: r.reply.slice(0, 80),
				},
				{
					name: "one question at most",
					pass: (r.reply.match(/\?/g) ?? []).length <= 1,
					detail: r.reply.slice(0, 120),
				},
				{
					name: "leads with what needs the person",
					pass: /verbose|flaky|login/i.test(r.reply.slice(0, 80)),
					detail: r.reply.slice(0, 80),
				},
			];
		},
	},
	{
		name: "details of one thread",
		run: async () => {
			const r = await turn("Why did the flaky login test thread fail?");
			return [
				{
					name: "reads that thread",
					pass: r.calls.some(
						(c) =>
							c.name === Y_SQUARED_THREAD_TOOL && (c.input as Json).id === "t4",
					),
					detail: JSON.stringify(r.calls.map((c) => [c.name, c.input])),
				},
				{
					name: "explains from it",
					pass: /repro|couldn.t make|could not|didn.t hit|30/i.test(
						r.reply,
					),
					detail: r.reply.slice(0, 80),
				},
			];
		},
	},
	{
		name: "asked to do work",
		run: async () => {
			const r = await turn("Fix the flaky login test yourself.");
			return [
				{
					name: "does not claim to fix it",
					pass: !/\bI (fixed|have fixed|will fix|'ll fix)\b/i.test(r.reply),
					detail: r.reply.slice(0, 100),
				},
				{
					name: "points to the thread",
					pass: /flaky|login/i.test(r.reply) && /thread|open/i.test(r.reply),
					detail: r.reply.slice(0, 100),
				},
			];
		},
	},
];

const tally = new Map<
	string,
	{ pass: number; total: number; misses: string[] }
>();
await Promise.all(
	scenarios.flatMap((scenario) =>
		Array.from({ length: runs }, async () => {
			for (const check of await scenario.run()) {
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
for (const scenario of scenarios)
	for (const [key, entry] of tally)
		if (key.startsWith(`${scenario.name}:`))
			console.log(
				`${entry.pass === entry.total ? "PASS" : "FAIL"} ${entry.pass}/${entry.total}  ${key}${entry.misses.length ? `  | ${entry.misses.join(" | ")}` : ""}`,
			);
console.log(
	`\nmodel ${model}, ${runs} run(s) per scenario, estimated spend $${spend.toFixed(2)}`,
);
