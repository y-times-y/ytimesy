/**
 * Claude delegation probe (2026-11-27): does a Claude model start a subagent
 * when the request parallelises? One request per (model, prompt): the
 * product's system prompt (cloudAgentRoleInstructions + orchestratorInstructions)
 * and the product's `agent` tool declaration, plus stub bash/read tools, called on
 * the Anthropic API for up to 8 steps. The first `agent` call is recorded and
 * the run stops; no child starts. Cost: a few cents per run.
 *
 *   ANTHROPIC_API_KEY=... tsx evals/delegation-probe/claude-live.ts --label before --out /tmp/x.json [--reps 1]
 */
import { writeFile } from "node:fs/promises";
import { cloudAgentRoleInstructions } from "../../src/domain/agent-orchestration";
import * as policy from "../../src/domain/delegation-policy";
import * as instructions from "../../src/domain/subagent-instructions";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** [prompt, shouldSpawn] */
const PROMPTS: [string, boolean][] = [
	[
		"Review packages/api/src/auth.ts, packages/api/src/billing.ts and packages/web/src/checkout.tsx for bugs and tell me what you find.",
		true,
	],
	[
		"Investigate why the nightly export is slow and also why signup emails arrive late. They are probably unrelated.",
		true,
	],
	[
		"Compare how the web app and the mobile app handle offline mode, then summarise the differences.",
		true,
	],
	[
		"Audit the repo for uses of the deprecated `legacyFetch` helper across all packages and report each caller with a migration plan.",
		true,
	],
	[
		"I need to understand the whole payments flow: checkout, webhooks, refunds and invoices. Map it for me.",
		true,
	],
	[
		"Research how three other open source projects implement rate limiting and tell me which fits our API best.",
		true,
	],
	[
		"Do a security review of the repo: auth, file uploads, and the admin routes.",
		true,
	],
	[
		"Find every place we parse dates in packages/ and check each for timezone bugs.",
		true,
	],
	[
		"Add a CSV export endpoint in packages/api/src/export/ and a matching Export button with its own tests in packages/web/src/reports/. The two parts are independent.",
		true,
	],
	[
		"Build three new independent pages: /settings/profile, /settings/billing and /settings/team, each in its own directory under packages/web/src/settings/ with tests.",
		true,
	],
	[
		"Migrate packages/legacy-a, packages/legacy-b and packages/legacy-c from JavaScript to TypeScript. They share no code.",
		true,
	],
	[
		"Read these 40 changelog files in docs/changelog/ and summarise what changed in 2025.",
		true,
	],
	["Fix the typo in README.md: 'recieve' should be 'receive'.", false],
	[
		"What does the function `formatMoney` in packages/web/src/money.ts do?",
		false,
	],
	[
		"Rename the variable `tmp` to `retryCount` in packages/api/src/retry.ts.",
		false,
	],
	[
		"Why does `pnpm test` fail in packages/api/src/auth.test.ts? Fix it.",
		false,
	],
	["Add a `--verbose` flag to the CLI in packages/cli/src/main.ts.", false],
	["Bump the version in package.json to 2.4.1.", false],
	["Explain what a Durable Object is in two sentences.", false],
	["Update the copyright year in the footer component.", false],
];

const description =
	(policy as Record<string, unknown>).AGENT_TOOL_DESCRIPTION ??
	"Start a subagent in the background. It sees only your brief (never this conversation), works within its own budget and reports back as a message; keep working meanwhile. Writers get a fork of your VM (your uncommitted work included) and return a patch and git ref for you to review and apply; readers share your VM read-only. Returns its id and budget.";

const roleText =
	"writer: edits code on a fork of your VM and returns a patch; researcher, reviewer: read-only on your VM; checker: independent pass/fail of your current work against the user's task";

const tools = [
	{
		name: "agent",
		description,
		input_schema: {
			type: "object",
			properties: {
				role: {
					type: "string",
					enum: ["writer", "researcher", "reviewer", "checker"],
					description: roleText,
				},
				title: {
					type: "string",
					description:
						'Its task in a few plain words, e.g. "Read package metadata"',
				},
				brief: {
					type: "string",
					description:
						"Self-contained: goal, context (paths, findings, working commands), constraints, what not to touch, report format.",
				},
				wait: {
					type: "boolean",
					description:
						"Readers only: block until the report (default false: keep working, the report arrives as a message)",
				},
			},
			required: ["role", "title"],
		},
	},
	{
		name: "agent_send",
		description: "Message or stop a running agent by id.",
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
		name: "bash",
		description: "Run a shell command in the workspace.",
		input_schema: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
	{
		name: "read",
		description: "Read a file.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

const system = [
	cloudAgentRoleInstructions({ delegates: true }),
	instructions.orchestratorInstructions({ main: true }),
	"Workspace: /workspace, a TypeScript pnpm monorepo (packages/api, packages/web, packages/cli, packages/legacy-a, packages/legacy-b, packages/legacy-c, docs/). About 900 files.",
].join("\n\n");

function stub(name: string, input: Record<string, unknown>) {
	if (name === "bash")
		return `$ ${String(input.command ?? "").slice(0, 80)}\npackages/api/src/auth.ts\npackages/api/src/billing.ts\npackages/web/src/checkout.tsx\n... (largely a 900-file repo; output truncated)\nexit 0`;
	return `// ${String(input.path ?? "")} (about 400 lines)\nexport function example() { /* ... */ }\n// many more functions elided`;
}

async function call(model: string, messages: unknown[]) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				max_tokens: 2048,
				system,
				tools,
				messages,
			}),
		});
		if (response.ok)
			return (await response.json()) as {
				content: {
					type: string;
					name?: string;
					id?: string;
					input?: Record<string, unknown>;
				}[];
			};
		if (response.status === 429 || response.status >= 500)
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
		else throw new Error(`anthropic ${response.status}`);
	}
	throw new Error("anthropic retries exhausted");
}

async function run(model: string, prompt: string) {
	const messages: unknown[] = [{ role: "user", content: prompt }];
	const names: string[] = [];
	for (let step = 0; step < 8; step++) {
		const reply = await call(model, messages);
		const uses = reply.content.filter((block) => block.type === "tool_use");
		names.push(...uses.map((use) => use.name ?? "?"));
		const spawn = uses.find((use) => use.name === "agent");
		if (spawn)
			return {
				spawned: String(spawn.input?.role ?? "?"),
				step: step + 1,
				names,
			};
		if (!uses.length) return { spawned: null, step: step + 1, names };
		messages.push({ role: "assistant", content: reply.content });
		messages.push({
			role: "user",
			content: uses.map((use) => ({
				type: "tool_result",
				tool_use_id: use.id,
				content: stub(use.name ?? "", use.input ?? {}),
			})),
		});
	}
	return { spawned: null, step: 8, names };
}

const arg = (name: string, fallback = "") =>
	process.argv[process.argv.indexOf(`--${name}`) + 1] ?? fallback;
const reps = Number(arg("reps", "1"));
const jobs = MODELS.flatMap((model) =>
	PROMPTS.flatMap(([prompt, positive], index) =>
		Array.from({ length: reps }, () => ({ model, prompt, positive, index })),
	),
);
const results: Record<string, unknown>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: 6 }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++];
			if (!job) break;
			const outcome = await run(job.model, job.prompt).catch((error) => ({
				spawned: null,
				step: 0,
				names: [`error:${String(error).slice(0, 40)}`],
			}));
			results.push({
				model: job.model,
				index: job.index,
				positive: job.positive,
				...outcome,
			});
		}
	}),
);
const summary = MODELS.map((model) => {
	const mine = results.filter((r) => r.model === model);
	const rate = (positive: boolean) => {
		const group = mine.filter((r) => r.positive === positive);
		return `${group.filter((r) => r.spawned).length}/${group.length}`;
	};
	const writers = mine.filter((r) => r.spawned === "writer").length;
	return {
		model,
		parallel_prompts_spawned: rate(true),
		small_prompts_spawned: rate(false),
		writers,
		errors: mine.filter((r) => String(r.names).includes("error:")).length,
	};
});
console.log(JSON.stringify(summary));
await writeFile(
	arg("out", "/tmp/delegation-claude.json"),
	JSON.stringify({ label: arg("label"), summary, results }, null, 1),
);
