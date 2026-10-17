// Development-only comparison: the native Codex CLI against the ytimesy builder
// harness on the same model (Codex subscription) and the smoke-suite tasks.
// Native runs execute locally in fresh temp repos; harness runs reuse the smoke
// suite's disposable-VM path on the development edge. Both arms use the same
// prompt and the same deterministic verifier.
//
// node --env-file=.env --import tsx scripts/native-vs-harness.ts --live
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	harnessVariantFromFlags,
	harnessVariantLabel,
} from "../src/domain/harness-variant";
import {
	assertDevelopmentDatabase,
	createHarnessRunner,
	emptyRecord,
	fixtureRepoScript,
	PROMPT_SUFFIX,
	percent,
	type RunRecord,
	safe,
	selectTasks,
	type Task,
	table,
	verifierCommand,
} from "./smoke/builder-harness";
import { createEvalUser, onEvalStop } from "./smoke/eval-user";

const NOTES = [
	"Same model, reasoning effort, prompt (task + smoke suffix), fixture repo and verifier in both arms. Differences in what is measured:",
	"- secs: native = CLI spawn to exit on this Mac; harness = task send to turn settled on the dev edge (includes queue/admission, excludes VM boot and fixture setup).",
	"- steps: harness = assistant messages in the turn transcript (one per model request); native = ESTIMATED from JSONL item boundaries (the CLI does not report request counts).",
	"- tools: harness = builder tool items (dynamic tools, commands, file changes); native = command_execution/file_change/mcp_tool_call/web_search items. Native 'failed' = non-zero exit or failed status.",
	"- tokens: both summed over every model request in the turn, input includes cached input (OpenAI usage semantics); cache% = cached/input. Harness from recorded apiUsage, native from turn.completed usage.",
	"- environment: harness = Linux Freestyle VM, full access, builder tools/system prompt; native = local macOS, workspace-write sandbox (no network) in a temp repo, clean CODEX_HOME (no user config, AGENTS.md, MCP, plugins or hooks), default service tier.",
];

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		model: { type: "string", default: "gpt-6.1-sol" },
		effort: { type: "string", default: "medium" },
		tasks: { type: "string" },
		repeat: { type: "string", default: "1" },
		arms: { type: "string", default: "native,harness" },
		"native-concurrency": { type: "string", default: "3" },
		"harness-concurrency": { type: "string", default: "5" },
		"turn-timeout": { type: "string", default: "300" },
		"codex-bin": { type: "string" },
		out: { type: "string" },
		/** Harness variant for the harness arm, e.g. memoryWording=rules (repeatable). */
		variant: { type: "string", multiple: true },
		/** Run the harness arm as the dev owner instead of a throwaway eval user. */
		"as-owner": { type: "boolean", default: false },
		/** The eval user's memory mode (default off). */
		memory: { type: "string", default: "off" },
	},
});
const variant = harnessVariantFromFlags(flags.variant);
if (!["off", "spec", "full"].includes(flags.memory as string))
	throw new Error("--memory accepts off, spec or full.");
if (!flags.live)
	throw new Error(
		"Refusing to run: pass --live (uses the Codex subscription and dev VMs).",
	);
const model = flags.model as string;
const effort = flags.effort as string;
if (!/^[a-z0-9._-]+$/.test(model) || !/^[a-z]+$/.test(effort))
	throw new Error("Invalid --model or --effort.");
const tasks = selectTasks(flags.tasks);
const repeat = Math.min(10, Math.max(1, Number(flags.repeat) || 1));
const arms = new Set(
	(flags.arms as string).split(",").map((arm) => arm.trim()),
);
if (![...arms].every((arm) => arm === "native" || arm === "harness"))
	throw new Error("--arms accepts native and/or harness.");
const nativeConcurrency = Math.min(
	5,
	Math.max(1, Number(flags["native-concurrency"]) || 3),
);
const harnessConcurrency = Math.min(
	10,
	Math.max(1, Number(flags["harness-concurrency"]) || 5),
);
const turnTimeoutMs =
	Math.min(900, Math.max(30, Number(flags["turn-timeout"]) || 300)) * 1000;
const outPath =
	flags.out ??
	`/tmp/native-vs-harness-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}.json`;
const harnessModel = `codex:${model}`;

// The PATH `codex` may be a terminal wrapper that injects hooks and MCP
// servers; resolve the real CLI instead.
const cleanPath = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((entry) => entry && !entry.includes("cmux"))
	.join(delimiter);
async function resolveCodex() {
	if (flags["codex-bin"]) return flags["codex-bin"];
	for (const entry of cleanPath.split(delimiter)) {
		const candidate = join(entry, "codex");
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error("codex CLI not found on PATH; pass --codex-bin.");
}

type Spawned = { code: number | null; stdout: string; stderr: string };
function run(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		env: NodeJS.ProcessEnv;
		input?: string;
		timeoutMs: number;
	},
): Promise<Spawned & { timedOut: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const killGroup = (signal: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, signal);
			} catch {}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 5000).unref();
		}, options.timeoutMs);
		liveChildren.add(killGroup);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			liveChildren.delete(killGroup);
			resolve({ code, stdout, stderr, timedOut });
		});
		child.stdin.end(options.input ?? "");
	});
}
const liveChildren = new Set<(signal: NodeJS.Signals) => void>();

type NativeItem = {
	id?: string;
	type?: string;
	status?: string;
	exit_code?: number | null;
	server?: string;
	tool?: string;
	message?: string;
};
type NativeEvent = {
	type?: string;
	item?: NativeItem;
	usage?: {
		input_tokens?: number;
		cached_input_tokens?: number;
		output_tokens?: number;
	};
	error?: { message?: string };
	message?: string;
};
const TOOL_TYPES: Record<string, string> = {
	command_execution: "command",
	file_change: "file_change",
	mcp_tool_call: "mcp",
	web_search: "web_search",
};

function measureNative(record: RunRecord, stdout: string) {
	const events: NativeEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	let input = 0;
	let cached = 0;
	let output = 0;
	let usageSeen = false;
	// A new model request starts when an item appears after a tool result.
	let steps = 0;
	let toolFinishedSinceStep = true;
	const seen = new Set<string>();
	for (const event of events) {
		const item = event.item;
		if (
			(event.type === "item.started" || event.type === "item.completed") &&
			item?.id &&
			!seen.has(item.id)
		) {
			seen.add(item.id);
			if (item.type !== "error") {
				if (toolFinishedSinceStep) steps++;
				toolFinishedSinceStep = false;
			}
		}
		if (event.type === "item.completed" && item) {
			const name = item.type ? TOOL_TYPES[item.type] : undefined;
			if (name) {
				toolFinishedSinceStep = true;
				const label = name === "mcp" ? `mcp:${item.tool ?? "?"}` : name;
				record.toolCalls++;
				record.toolsUsed[label] = (record.toolsUsed[label] ?? 0) + 1;
				if (
					item.status === "failed" ||
					(typeof item.exit_code === "number" && item.exit_code !== 0)
				) {
					record.failedToolCalls++;
					record.failedByTool[label] = (record.failedByTool[label] ?? 0) + 1;
				}
			}
			if (item.type === "error" && item.message)
				record.errors.push(safe(item.message));
		}
		if (event.type === "turn.completed") {
			record.state = "completed";
			if (event.usage) {
				usageSeen = true;
				input += event.usage.input_tokens ?? 0;
				cached += event.usage.cached_input_tokens ?? 0;
				output += event.usage.output_tokens ?? 0;
			}
		}
		if (event.type === "turn.failed" || event.type === "error") {
			record.state = "failed";
			record.errors.push(
				safe(event.error?.message ?? event.message ?? event.type),
			);
		}
	}
	record.modelSteps = steps;
	if (usageSeen) {
		record.inputTokens = input;
		record.cachedTokens = cached;
		record.outputTokens = output;
		record.cacheHitPercent = percent(cached, input);
	}
	record.errors = [...new Set(record.errors)];
}

async function runNative(
	codex: string,
	codexHome: string,
	task: Task,
): Promise<RunRecord> {
	const record = emptyRecord(`native:${model}`, task.id);
	if (stopping) {
		record.state = "skipped";
		return record;
	}
	const dir = await mkdtemp(join(tmpdir(), `native-rig-${task.id}-`));
	const env = {
		PATH: cleanPath,
		HOME: process.env.HOME ?? homedir(),
		USER: process.env.USER,
		SHELL: process.env.SHELL,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR,
		CODEX_HOME: codexHome,
	};
	try {
		for (const [path, content] of Object.entries(task.files)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), content);
		}
		const setup = await run("bash", ["-c", fixtureRepoScript(dir)], {
			env,
			timeoutMs: 20_000,
		});
		if (setup.code) throw new Error("Fixture repository setup failed.");
		const started = Date.now();
		const result = await run(
			codex,
			[
				"exec",
				"--json",
				"--color",
				"never",
				"--ephemeral",
				"--skip-git-repo-check",
				"--model",
				model,
				"-c",
				`model_reasoning_effort="${effort}"`,
				"-c",
				'approval_policy="never"',
				"--sandbox",
				"workspace-write",
				"-C",
				dir,
				"-",
			],
			{
				cwd: dir,
				env,
				input: `${task.prompt}${PROMPT_SUFFIX}`,
				timeoutMs: turnTimeoutMs,
			},
		);
		record.elapsedMs = Date.now() - started;
		record.state = "incomplete";
		measureNative(record, result.stdout);
		if (result.timedOut) {
			record.state = "timeout";
			record.errors.push(`Cancelled: exceeded ${turnTimeoutMs / 1000}s.`);
		} else if (result.code !== 0) {
			if (record.state === "completed") record.state = "failed";
			record.errors.push(
				`codex exited ${result.code}: ${safe(result.stderr.trim().slice(-300))}`,
			);
		}
		record.completed = record.state === "completed";
		const verified = await run("bash", ["-c", verifierCommand(task)], {
			cwd: dir,
			env,
			timeoutMs: 60_000,
		});
		record.verifierPassed = verified.code === 0;
		record.verifierOutput = safe(
			`${verified.stdout}${verified.stderr}`.trim().slice(-400),
		);
	} catch (error) {
		record.errors.push(safe(error));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return record;
}

async function pool<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>,
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await work(items[next++]);
		}),
	);
}

let stopping = false;
let runner: Awaited<ReturnType<typeof createHarnessRunner>> | undefined;
onEvalStop(() => {
	stopping = true;
	runner?.stop();
	for (const kill of liveChildren) kill("SIGTERM");
});

const startedAt = new Date().toISOString();
const queue = tasks.flatMap((task) =>
	Array.from({ length: repeat }, (_, attempt) => ({ task, attempt })),
);
const nativeRuns: RunRecord[] = [];
const harnessRuns: RunRecord[] = [];
const log = (arm: string, record: RunRecord) =>
	console.info(
		`${record.verifierPassed ? "PASS" : "FAIL"} ${arm} ${record.task} ${record.state} ${(record.elapsedMs / 1000).toFixed(0)}s steps=${record.modelSteps ?? "-"} tools=${record.toolCalls}`,
	);
let codexVersion: string | null = null;
let codexHome: string | undefined;
const leaked: string[] = [];
try {
	const work: Promise<void>[] = [];
	if (arms.has("harness")) {
		await assertDevelopmentDatabase();
		const user = await createEvalUser({
			label: `native-vs-harness ${harnessVariantLabel(variant)}`,
			variant,
			asOwner: flags["as-owner"],
			memory: flags.memory as "off" | "spec" | "full",
		});
		console.info(
			`Harness arm runs as ${user.asOwner ? "the owner" : `eval user ${user.userId}`} (variant ${harnessVariantLabel(variant)}).`,
		);
		runner = await createHarnessRunner({
			user,
			models: [harnessModel],
			concurrency: harnessConcurrency,
			turnTimeoutMs,
			// The Codex subscription has no per-token charge.
			costOf: () => 0,
			reasoning: effort,
		}).catch(async (error) => {
			await user.release();
			throw error;
		});
		await runner.preflightExecutor();
		const harness = runner;
		work.push(
			pool(queue, harnessConcurrency, async ({ task }) => {
				const record = await harness.runOne(harnessModel, task, 1);
				harnessRuns.push(record);
				log("harness", record);
			}),
		);
	}
	if (arms.has("native")) {
		const codex = await resolveCodex();
		codexVersion = (
			await run(codex, ["--version"], {
				env: { PATH: cleanPath },
				timeoutMs: 15_000,
			})
		).stdout.trim();
		// A clean home keeps user config, AGENTS.md, MCP servers, plugins and
		// hooks out of the native arm. auth.json is linked, never copied.
		codexHome = await mkdtemp(join(tmpdir(), "native-rig-codex-home-"));
		await symlink(
			join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
			join(codexHome, "auth.json"),
		);
		const home = codexHome;
		work.push(
			pool(queue, nativeConcurrency, async ({ task }) => {
				const record = await runNative(codex, home, task);
				nativeRuns.push(record);
				log("native", record);
			}),
		);
	}
	console.info(
		`Running ${queue.length} tasks x [${[...arms].join(", ")}] on ${model} (effort ${effort}); native concurrency ${nativeConcurrency}, harness ${harnessConcurrency}.`,
	);
	await Promise.all(work);
} finally {
	if (runner) leaked.push(...(await runner.cleanup()));
	if (codexHome) await rm(codexHome, { recursive: true, force: true });
	if (leaked.length) {
		console.error(`Cleanup incomplete: ${leaked.join(", ")}.`);
		process.exitCode = 1;
	}
}

const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};
const mean = (values: (number | null)[]) => {
	const known = values.filter((value): value is number => value !== null);
	return known.length
		? Math.round(known.reduce((a, b) => a + b, 0) / known.length)
		: null;
};
function aggregate(runs: RunRecord[]) {
	const input = runs.reduce((total, run) => total + (run.inputTokens ?? 0), 0);
	const cached = runs.reduce(
		(total, run) => total + (run.cachedTokens ?? 0),
		0,
	);
	const failedByTool: Record<string, number> = {};
	for (const run of runs)
		for (const [tool, count] of Object.entries(run.failedByTool))
			failedByTool[tool] = (failedByTool[tool] ?? 0) + count;
	return {
		runs: runs.length,
		verified: runs.filter((run) => run.verifierPassed).length,
		completed: runs.filter((run) => run.completed).length,
		medianSeconds: (() => {
			const value = median(runs.map((run) => run.elapsedMs));
			return value === null ? null : Math.round(value / 1000);
		})(),
		meanSteps: mean(runs.map((run) => run.modelSteps)),
		meanToolCalls: mean(runs.map((run) => run.toolCalls)),
		failedToolCalls: runs.reduce(
			(total, run) => total + run.failedToolCalls,
			0,
		),
		failedByTool,
		meanInputTokens: mean(runs.map((run) => run.inputTokens)),
		meanOutputTokens: mean(runs.map((run) => run.outputTokens)),
		cacheHitPercent: percent(cached, input),
	};
}
const cells = (stats: ReturnType<typeof aggregate>) =>
	stats.runs
		? [
				`${stats.verified}/${stats.runs}`,
				String(stats.medianSeconds ?? "-"),
				String(stats.meanSteps ?? "-"),
				`${stats.meanToolCalls ?? "-"}${stats.failedToolCalls ? `(${stats.failedToolCalls}f)` : ""}`,
				String(stats.meanInputTokens ?? "-"),
				String(stats.cacheHitPercent ?? "-"),
				String(stats.meanOutputTokens ?? "-"),
			]
		: Array(7).fill("-");
const columns = ["pass", "secs", "steps", "tools", "in", "cache%", "out"];
const perTask = tasks.map((task) => ({
	task: task.id,
	native: aggregate(nativeRuns.filter((run) => run.task === task.id)),
	harness: aggregate(harnessRuns.filter((run) => run.task === task.id)),
}));
const summary = {
	native: aggregate(nativeRuns),
	harness: aggregate(harnessRuns),
};
console.info(
	`\n${NOTES.join("\n")}\n${repeat > 1 ? `Per task: pass count, median secs, mean of the other columns over ${repeat} repeats.\n` : ""}\n${table(
		[
			[
				"task",
				...columns.map((c) => `N.${c}`),
				"|",
				...columns.map((c) => `H.${c}`),
			],
			...perTask.map((row) => [
				row.task,
				...cells(row.native),
				"|",
				...cells(row.harness),
			]),
			["ALL", ...cells(summary.native), "|", ...cells(summary.harness)],
		],
	)}\n(N = native Codex CLI ${codexVersion ?? ""}, H = ytimesy builder; tools shows mean calls and total failed as (nf); ALL row = median secs and per-run means over all runs.)`,
);
for (const [arm, runs] of [
	["native", nativeRuns],
	["harness", harnessRuns],
] as const)
	for (const run of runs)
		if (run.errors.length || run.verifierPassed === false)
			console.info(
				`${arm} ${run.task}: ${[...run.errors, run.verifierPassed === false ? `verifier: ${run.verifierOutput}` : ""].filter(Boolean).join(" | ")}`,
			);
await writeFile(
	outPath,
	`${JSON.stringify(
		{
			startedAt,
			finishedAt: new Date().toISOString(),
			notes: NOTES,
			config: {
				model,
				effort,
				tasks: tasks.map((task) => task.id),
				repeat,
				arms: [...arms],
				variant: harnessVariantLabel(variant),
				nativeConcurrency,
				harnessConcurrency,
				turnTimeoutSeconds: turnTimeoutMs / 1000,
				codexVersion,
			},
			summary,
			perTask,
			runs: { native: nativeRuns, harness: harnessRuns },
		},
		null,
		2,
	)}\n`,
);
console.info(`\nWrote ${outPath}`);
