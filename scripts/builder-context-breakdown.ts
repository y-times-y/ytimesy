// Prints what fills a root builder's FIRST model request on a tiny fixture
// repository, by component, for the Codex subscription transport and an
// OpenRouter Claude connection. It runs the real tool set, repository
// instructions, initial reads, prompt assembly and provider adapters; the
// "VM" is a local fixture directory (commands run locally against it) and
// the provider fetch captures the HTTP body instead of sending it. No
// network, database or VM is used.
//
//   node --import tsx scripts/builder-context-breakdown.ts [--json] [--repo <path>]
//
// Token counts are estimates: characters / 4 of the JSON actually sent (no
// tokenizer is installed). Claude's tokenizer yields more tokens per
// character than OpenAI's, so treat the Claude column as a lower bound.
//
// Not included, because they come from the account rather than the code:
// the user's remote MCP tools and installed plugin skills (both sent in full
// on every request), and the delegation snapshot notice (database).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { nativeWebSearchTools } from "#/server/adapters/native-web-search";
import { agentTurnInstructions } from "#/server/services/agent-turn-instructions";
import { apiAgentTools } from "#/server/services/api-agent-tools";
import { automaticRepositoryContext } from "#/server/services/automatic-repository-context";
import { builderShellTools } from "#/server/services/builder-shell-surface";
import {
	type ModelAgentRuntime,
	runModelAgentStep,
} from "#/server/services/model-agent-loop";
import { PlanLock, planTools } from "#/server/services/plan-mode";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const FILES: Record<string, string> = {
	"README.md": "Word counting fixture.\n",
	"AGENTS.md":
		"# Repository rules\n\nRun `python3 -m unittest` before finishing. See [the style notes](docs/style.md).\n",
	"docs/style.md": "# Style\n\nUse four-space indentation.\n",
	"words.py": "def count_words(text):\n    return len(text.split())\n",
	"test_words.py":
		"import unittest\nfrom words import count_words\n\nclass T(unittest.TestCase):\n    def test_count(self):\n        self.assertEqual(count_words('a b'), 2)\n",
	"package.json": `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "python3 -m unittest" } }, null, 2)}\n`,
};
const PROMPT =
	"Add a function count_lines(text) to words.py that returns the number of lines, with a test.";

class Captured extends Error {}

/** The root builder's tools, instructions and message preparation, assembled as api-turn.ts does. */
async function builderTurnRequest(input: {
	transport: "codex" | "openrouter-claude";
	repo: string;
	prompt: string;
	exec: (
		command: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}) {
	const vm = WorkspaceId("fixture-vm");
	const machines = {
		exec: (_vm: unknown, command: string) => input.exec(command),
		readTextFile: async () => null,
		writeTextFile: async () => {},
	} as unknown as WorkspaceMachines;
	const session = {
		id: "00000000-0000-4000-8000-000000000001",
		userId: "fixture-owner",
		projectId: "00000000-0000-4000-8000-000000000002",
		workspaceId: "00000000-0000-4000-8000-000000000003",
		harness: input.transport === "codex" ? "codex" : "api",
		providerRef: vm,
		parentSessionId: null,
		title: "Fixture",
		taskAccess: null,
	} as unknown as AgentSessionRecord;
	const signal = new AbortController().signal;
	const workspace = async () => ({ machines, vm, cwd: input.repo });
	const repositoryContext = automaticRepositoryContext({
		tools: apiAgentTools({
			machines,
			session,
			workspace,
			turnId: "fixture-turn",
			signal,
			writable: true,
		}),
		workspace,
		signal,
		instructionMessages: { turnStart: true },
		onEvent: async () => {},
	});
	const tools: ToolSet = {
		...builderShellTools(repositoryContext.tools),
		...planTools(new PlanLock({ kind: "none" })),
		...nativeWebSearchTools(
			input.transport === "codex" ? "openai" : "openrouter",
		),
	};
	return {
		tools,
		instructions: agentTurnInstructions({
			shellBuilder: true,
			session,
			tools,
			plugins: [],
			projectKnowledge: null,
		}),
		messages: [{ role: "user", content: input.prompt }] as ModelMessage[],
		prepareMessages: repositoryContext.prepare,
	};
}

function sh(command: string, cwd: string) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(done) =>
			execFile(
				"bash",
				["-c", command],
				{ cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
				(error, stdout, stderr) =>
					done({
						exitCode:
							error && typeof error.code === "number"
								? error.code
								: error
									? 1
									: 0,
						stdout,
						stderr,
					}),
			),
	);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "builder-context-"));
	const repo = join(root, "fixture");
	for (const [path, content] of Object.entries(FILES)) {
		await mkdir(join(repo, path, ".."), { recursive: true });
		await writeFile(join(repo, path), content);
	}
	await sh(
		"git init -q && git add -A && git -c user.name=f -c user.email=f@example.invalid commit -qm fixture",
		repo,
	);
	return { root, repo, report: join(root, "ytimesy-environment.json") };
}

function environmentReport(repo: string) {
	// What environment-build.ts writes for one repository with one check.
	return JSON.stringify({
		version: 1,
		repositories: [
			{
				repositoryId: 1,
				installationId: 2,
				fullName: "owner/fixture",
				branch: "main",
				commit: "0".repeat(40),
				directory: repo,
				recipe: {
					version: 1,
					buildSecrets: [],
					verify: [],
					checks: ["python3 -m unittest"],
					parallelChecks: [],
					services: [],
					timeoutSeconds: 900,
				},
				checkResults: [{ command: "python3 -m unittest", exitCode: 0 }],
			},
		],
	});
}

type Body = Record<string, unknown>;

async function firstRequest(
	transport: "codex" | "openrouter-claude",
	repo: string,
	report: string,
) {
	let body: Body | undefined;
	const capture: typeof fetch = async (_url, init) => {
		body = JSON.parse(String(init?.body));
		throw new Captured();
	};
	const request = await builderTurnRequest({
		transport,
		repo,
		prompt: PROMPT,
		exec: (command) =>
			sh(command.replaceAll("/tmp/ytimesy-environment.json", report), repo),
	});
	const runtime: ModelAgentRuntime =
		transport === "codex"
			? {
					model: connectedLanguageModel(
						{
							provider: "openai",
							baseUrl: "https://chatgpt.com/backend-api/codex",
							modelId: "gpt-6.1-sol",
							apiKey: "fixture",
						},
						capture,
					),
					// As the subscription catalog reports it; without a window the loop refuses large histories.
					contextWindow: 500_000,
					prefetchInitialReads: true,
					requestSettings: (instructions) => ({
						providerOptions: {
							openai: {
								instructions,
								store: false,
								promptCacheKey: "fixture",
								reasoningEffort: "medium",
								reasoningSummary: "auto",
								parallelToolCalls: true,
							},
						},
					}),
				}
			: {
					model: connectedLanguageModel(
						{
							provider: "openrouter",
							baseUrl: "https://openrouter.ai/api/v1",
							modelId: "anthropic/claude-sonnet-5.5",
							apiKey: "fixture",
						},
						capture,
					),
					maxOutputTokens: 8192,
					contextWindow: 1_000_000,
					fallbackContextPolicy: "bound-prefix",
					requestSettings: (instructions) => ({ system: instructions }),
				};
	await runModelAgentStep(
		{
			userId: "fixture-owner",
			modelId:
				transport === "codex" ? "gpt-6.1-sol" : "anthropic/claude-sonnet-5.5",
			toolSurface: "implementation",
			instructions: request.instructions,
			messages: request.messages,
			tools: request.tools,
			prepareMessages: request.prepareMessages,
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
		},
		runtime,
	).catch((error) => {
		if (!body) throw (error as { cause?: unknown }).cause ?? error;
	});
	if (!body) throw new Error("No request was captured.");
	return body;
}

const size = (value: unknown) =>
	typeof value === "string" ? value.length : JSON.stringify(value).length;
const tokens = (characters: number) => Math.round(characters / 4);

/** Split the captured provider body into named components. */
function components(body: Body) {
	const rows: [string, number][] = [];
	const add = (name: string, value: unknown) =>
		rows.push([name, size(value ?? "")]);
	const tools = (body.tools ?? []) as Body[];
	const named = (tool: Body) =>
		String(
			tool.name ??
				(tool.function as Body | undefined)?.name ??
				tool.type ??
				"tool",
		);
	if (typeof body.instructions === "string")
		add("system instructions", body.instructions);
	for (const tool of tools)
		if (tool.type !== "function") add(`provider tool: ${named(tool)}`, tool);
	add(
		"tool definitions (function schemas)",
		tools.filter((tool) => tool.type === "function"),
	);
	const items = (body.input ?? body.messages ?? []) as Body[];
	for (const item of items) {
		const text = JSON.stringify(item);
		const label =
			item.role === "system" || item.role === "developer"
				? "system instructions"
				: text.includes("# Repository instructions")
					? "repository instructions message"
					: text.includes("read_environment_report") ||
							text.includes("call_prefetch_")
						? "environment report prefetch"
						: text.includes("Current delegated tasks")
							? "delegation snapshot notice"
							: text.includes(PROMPT.slice(0, 30))
								? "user message"
								: `other ${String(item.role ?? item.type)}`;
		add(label, item);
	}
	const merged = new Map<string, number>();
	for (const [name, characters] of rows)
		merged.set(name, (merged.get(name) ?? 0) + characters);
	merged.set("total request body", size(body));
	return merged;
}

// --repo <path> measures an existing checkout instead of the tiny fixture;
// the scan only reads it (git ls-files, file reads).
const repoFlag = process.argv.indexOf("--repo");
const fixtureCheckout = await fixture();
const root = fixtureCheckout.root;
const report = fixtureCheckout.report;
const repo =
	repoFlag > 0 ? resolve(process.argv[repoFlag + 1]) : fixtureCheckout.repo;
await writeFile(report, environmentReport(repo));
try {
	const results = {
		codex: components(await firstRequest("codex", repo, report)),
		"openrouter-claude": components(
			await firstRequest("openrouter-claude", repo, report),
		),
	};
	if (process.argv.includes("--json")) {
		console.log(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(results).map(([key, map]) => [
						key,
						Object.fromEntries(map),
					]),
				),
				null,
				2,
			),
		);
	} else {
		const names = [
			...new Set(Object.values(results).flatMap((map) => [...map.keys()])),
		];
		console.log(
			`${"component".padEnd(42)}${"codex chars".padStart(12)}${"~tok".padStart(8)}${"claude chars".padStart(14)}${"~tok".padStart(8)}`,
		);
		for (const name of names) {
			const codex = results.codex.get(name) ?? 0;
			const claude = results["openrouter-claude"].get(name) ?? 0;
			console.log(
				`${name.padEnd(42)}${String(codex).padStart(12)}${String(tokens(codex)).padStart(8)}${String(claude).padStart(14)}${String(tokens(claude)).padStart(8)}`,
			);
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
