// Development-only checker detection test (docs/checker-detect.md): an
// independent checker reviews finished builder runs from our frozen TB4 run,
// given only the task instruction and the run's final workspace restored into
// the task's own environment (tests and solution absent), and a separate
// blind grading step says whether it named the cause of each hidden failure.
//
// node --env-file=.env --import tsx scripts/checker-detect.ts --prepare --data <dir>
// node --env-file=.env --import tsx scripts/checker-detect.ts --list --data <dir>
// node --env-file=.env --import tsx scripts/checker-detect.ts --dry-run --run <name> --data <dir> --chunk 1
// node --env-file=.env --import tsx scripts/checker-detect.ts --live --run <name> --data <dir> --chunk 1
// node --env-file=.env --import tsx scripts/checker-detect.ts --grade --run <name> --data <dir> [--live]
// node --env-file=.env --import tsx scripts/checker-detect.ts --report --run <name> --data <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
	independentReviewBrief,
	parseReviewVerdict,
	type ReviewVerdict,
} from "../src/domain/checker-brief";
import { harnessVariantFromFlags } from "../src/domain/harness-variant";
import { WorkspaceId } from "../src/domain/ids";
import {
	lastAgentMessageText,
	sessionItemsFromUnknown,
} from "../src/domain/session-item";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../src/server/adapters/database";
import { dispatchModelWorkflow } from "../src/server/adapters/model-workflow-dispatch";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";
import {
	blindId,
	controlRates,
	failingRates,
	failureEvidence,
	formatRates,
	GRADE_SCHEMA,
	type Grade,
	type GraderFiles,
	gradingPrompt,
	outcomeOf,
	parseGrade,
} from "./checker-detect/grading";
import {
	outsideFiles,
	parseRestoreLog,
	type RestoreResult,
	restoreProblems,
	restoreScript,
} from "./checker-detect/restore";
import {
	type Sample,
	type Selection,
	selectSamples,
	type TaskFacts,
	type TrialSummary,
} from "./checker-detect/select";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";
import {
	loadTaskEnvironment,
	setupFiles,
	type TaskEnvironment,
} from "./hard-set/environment";
import { HARD_SET } from "./hard-set/tasks";
import { codexUsage, preflightExecutor, taskVms } from "./hard-set/vm";
import {
	emptyRecord,
	measureRun,
	type RunRecord,
	safe,
	table,
	turnState,
} from "./smoke/builder-harness";
import {
	assertDevelopmentDatabase,
	createEvalUser,
	type EvalUser,
	onEvalStop,
	SLOT_LIMITS,
	subscriptionOwner,
	withSlot,
} from "./smoke/eval-user";

const DEFAULT_DATASET = resolve("../cloud/.ytimesy/tb4-dataset");
const RUNS = resolve(".ytimesy/checker-detect");
const USAGE_LIMIT = /usage limit is used up|usage_limit_reached/i;
/** Samples per chunk: each chunk is one invocation of at most ten minutes. */
const CHUNK_SIZE = 4;
/** Wall time kept after the checker's turn (cancel, settle, read the report). */
const AFTER_CHECK_RESERVE_SEC = 40;
/** Where the checker writes its copies and scripts, in the task container. */
const CHECKER_SCRATCH = "/tmp/ytimesy-check";

const { values: flags } = parseArgs({
	options: {
		prepare: { type: "boolean", default: false },
		list: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		live: { type: "boolean", default: false },
		grade: { type: "boolean", default: false },
		report: { type: "boolean", default: false },
		/** Extracted backup, sample bundles and the selection live here. */
		data: { type: "string", default: ".ytimesy/checker-detect/data" },
		/** The extracted TB4 backup (default <data>/backup). */
		backup: { type: "string" },
		dataset: { type: "string", default: DEFAULT_DATASET },
		run: { type: "string" },
		samples: { type: "string" },
		chunk: { type: "string" },
		model: { type: "string", default: "gpt-6.1-sol" },
		reasoning: { type: "string" },
		"grader-model": { type: "string", default: "gpt-6.1-sol" },
		/** The checker's time per sample (minutes). */
		"agent-minutes": { type: "string", default: "7" },
		"max-minutes": { type: "string", default: "10" },
		concurrency: { type: "string" },
		transcripts: { type: "boolean", default: false },
		/** With --dry-run: on the local Docker host instead of development VMs. */
		local: { type: "boolean", default: false },
	},
});

const dataDir = resolve(flags.data as string);
const selectionPath = join(dataDir, "selection.json");
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const sampleDir = (sample: Sample) => join(dataDir, "samples", sample.id);

async function readSelection(): Promise<Selection> {
	if (!existsSync(selectionPath))
		throw new Error(`No selection at ${selectionPath}; run --prepare first.`);
	return JSON.parse(await readFile(selectionPath, "utf8")) as Selection;
}

const chunksOf = (samples: readonly Sample[]) =>
	Array.from({ length: Math.ceil(samples.length / CHUNK_SIZE) }, (_, index) =>
		samples.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
	);

// ----------------------------------------------------------------------------
// --prepare: survey the backup, select, and bundle each sample.

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function bytesOf(path: string): Promise<number> {
	const info = await stat(path).catch(() => null);
	if (!info) return 0;
	if (info.isFile()) return info.size;
	if (!info.isDirectory()) return 0;
	let total = 0;
	for (const entry of await readdir(path))
		if (entry !== ".git") total += await bytesOf(join(path, entry));
	return total;
}

const normalizeSource = (source: string) => source.replace(/\/+$/, "") || "/";

/** Trial directories as the official TB4 scorer finds them (warm-up and invalid jobs left out). */
async function trialDirectories(backup: string) {
	const found: string[] = [];
	for (const root of ["jobs", "freestyle-jobs", "h100/jobs"]) {
		const jobs = await readdir(join(backup, root)).catch(() => [] as string[]);
		for (const job of jobs) {
			const entries = await readdir(join(backup, root, job)).catch(
				() => [] as string[],
			);
			for (const entry of entries) {
				const path = join(backup, root, job, entry);
				if (!entry.includes("__") || /warm|invalid/.test(path)) continue;
				if ((await stat(path)).isDirectory()) found.push(path);
			}
		}
	}
	return found.sort();
}

async function summarizeTrial(path: string): Promise<TrialSummary> {
	const trial = path.split("/").at(-1) as string;
	const task = trial.split("__")[0];
	const result = (await readJson(join(path, "result.json"))) as Record<
		string,
		Record<string, unknown> | null
	> | null;
	const started = !!result?.agent_execution?.started_at;
	const rewards = (result?.verifier_result?.rewards ?? null) as Record<
		string,
		unknown
	> | null;
	const reward = typeof rewards?.reward === "number" ? rewards.reward : null;
	const trace = (await readJson(join(path, "agent", "ytimesy-trace.json"))) as {
		events?: { type?: string }[];
	} | null;
	const modelCalled =
		!trace?.events || trace.events.some((event) => event.type === "usage");
	const manifest = ((await readJson(
		join(path, "artifacts", "manifest.json"),
	)) ?? []) as {
		source: string;
		destination: string;
		status: string;
		service: string | null;
	}[];
	const artifacts = await Promise.all(
		manifest
			.filter((entry) => normalizeSource(entry.source) !== "/logs/artifacts")
			.map(async (entry) => ({
				source: entry.source,
				service: entry.service ?? "main",
				status: entry.status,
				bytes: await bytesOf(join(path, entry.destination)),
			})),
	);
	const verifier = join(path, "verifier");
	const evidenceFiles: string[] = [];
	for (const name of await readdir(verifier).catch(() => [] as string[])) {
		if (/^reward\.(txt|json)$/.test(name) || !/\.(txt|json|log)$/.test(name))
			continue;
		if ((await stat(join(verifier, name))).size > 0) evidenceFiles.push(name);
	}
	return {
		task,
		trial,
		path,
		reward,
		scored: started && reward !== null && modelCalled,
		artifacts,
		evidenceFiles: evidenceFiles.sort(),
	};
}

async function taskFacts(dataset: string, id: string): Promise<TaskFacts> {
	const dir = join(dataset, id);
	const config = JSON.parse(
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))",
				join(dir, "task.toml"),
			],
			{ encoding: "utf8" },
		),
	) as { environment?: Record<string, unknown> };
	const environment = config.environment ?? {};
	const compose = await readFile(
		join(dir, "environment", "docker-compose.yaml"),
		"utf8",
	).catch(() => "");
	return {
		id,
		gpus: Number(environment.gpus ?? 0),
		mcpServers: ((environment.mcp_servers ?? []) as unknown[]).length,
		cpus: Number(environment.cpus ?? 2),
		memoryMb: Number(environment.memory_mb ?? 4096),
		buildsImage: /^\s+build\s*:/m.test(compose),
		hasSidecars: (compose.match(/^ {2}[A-Za-z0-9_-]+:\s*$/gm) ?? []).length > 1,
	};
}

/**
 * One sample's bundle: workspace.tgz in the hard-set staging layout
 * (`<artifact index>/<basename>`, git history left out) for the checker's
 * environment, and grader/ (the hidden grader's output, for grading only;
 * it never goes to a VM).
 */
async function bundleSample(sample: Sample, environment: TaskEnvironment) {
	const out = sampleDir(sample);
	await rm(out, { recursive: true, force: true });
	const staging = join(out, "workspace");
	await mkdir(staging, { recursive: true });
	const manifest = ((await readJson(
		join(sample.path, "artifacts", "manifest.json"),
	)) ?? []) as { source: string; destination: string }[];
	for (const [index, artifact] of environment.artifacts.entries()) {
		const entry = manifest.find(
			(item) =>
				normalizeSource(item.source) === normalizeSource(artifact.source),
		);
		if (!entry) throw new Error(`${sample.id}: no saved ${artifact.source}`);
		const base = normalizeSource(artifact.source).split("/").at(-1) as string;
		await mkdir(join(staging, String(index)), { recursive: true });
		await cp(
			join(sample.path, entry.destination),
			join(staging, String(index), base),
			{
				recursive: true,
				verbatimSymlinks: true,
				filter: (source) => !source.split("/").includes(".git"),
			},
		);
	}
	execFileSync("tar", ["-czf", join(out, "workspace.tgz"), "-C", staging, "."]);
	await rm(staging, { recursive: true, force: true });
	const grader = join(out, "grader");
	await mkdir(grader, { recursive: true });
	for (const name of await readdir(join(sample.path, "verifier")).catch(
		() => [] as string[],
	))
		if (/\.(txt|json|log)$/.test(name))
			await cp(join(sample.path, "verifier", name), join(grader, name));
	await writeFile(
		join(out, "meta.json"),
		`${JSON.stringify({ ...sample, artifacts: environment.artifacts }, null, 2)}\n`,
	);
}

if (flags.prepare) {
	const backup = resolve(flags.backup ?? join(dataDir, "backup"));
	const dataset = resolve(flags.dataset as string);
	const trials = await Promise.all(
		(await trialDirectories(backup)).map(summarizeTrial),
	);
	const ids = [...new Set(trials.map((trial) => trial.task))].sort();
	const facts = (
		await Promise.all(
			ids.map((id) =>
				existsSync(join(dataset, id, "task.toml"))
					? taskFacts(dataset, id)
					: null,
			),
		)
	).filter((fact): fact is TaskFacts => !!fact);
	const selection = selectSamples(trials, facts);
	await mkdir(dataDir, { recursive: true });
	await writeFile(
		join(dataDir, "survey.json"),
		`${JSON.stringify({ trials, facts }, null, 1)}\n`,
	);
	for (const sample of selection.samples)
		await bundleSample(sample, await loadTaskEnvironment(dataset, sample.task));
	await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
	console.log(
		`${trials.length} trials, ${selection.samples.length} samples -> ${selectionPath}`,
	);
	flags.list = true;
}

if (flags.list) {
	const selection = await readSelection();
	console.log(selection.rule);
	console.log(
		table([
			["chunk", "sample", "kind", "reward", "caveats"],
			...chunksOf(selection.samples).flatMap((chunk, index) =>
				chunk.map((sample) => [
					String(index + 1),
					sample.id,
					sample.kind,
					String(sample.reward),
					sample.caveats.join("; ").slice(0, 80),
				]),
			),
		]),
	);
	console.log(
		`Excluded tasks: ${selection.excludedTasks.map((entry) => `${entry.task} (${entry.reason})`).join(", ")}`,
	);
	process.exit(0);
}

// ----------------------------------------------------------------------------
// Records.

type CheckRecord = RunRecord & {
	run: string;
	sample: string;
	kind: Sample["kind"];
	mode: "dry-run" | "live";
	startedAt: string;
	setupSec: number;
	restoreSec: number;
	agentSec: number;
	agentBudgetSec: number;
	workdir: string | null;
	restore: RestoreResult | null;
	restoreProblems: string[];
	/** The restore script's output (tail). */
	restoreLog?: string;
	brief: string | null;
	report: string | null;
	verdict: ReviewVerdict | null;
	usageLimit: string | null;
	vmResources: string | null;
};

function runDirectory() {
	const run = flags.run;
	if (!run || !/^[A-Za-z0-9._=-]{1,80}$/.test(run))
		throw new Error("Pass --run <name> (letters, digits, . _ = -).");
	return join(RUNS, run);
}

async function readRecords(dir: string) {
	const files = (await readdir(dir).catch(() => [] as string[])).filter(
		(file) => /^[^.].*\.\d+\.json$/.test(file),
	);
	return Promise.all(
		files.map(
			async (file) =>
				JSON.parse(await readFile(join(dir, file), "utf8")) as CheckRecord,
		),
	);
}

/** The latest live record per sample (dry runs never count). */
function latestLive(records: readonly CheckRecord[]) {
	const latest = new Map<string, CheckRecord>();
	for (const record of records)
		if (record.mode === "live") {
			const seen = latest.get(record.sample);
			if (!seen || seen.startedAt < record.startedAt)
				latest.set(record.sample, record);
		}
	return latest;
}

async function graderFiles(sample: Sample): Promise<GraderFiles> {
	const dir = join(sampleDir(sample), "grader");
	const files: Record<string, string> = {};
	for (const name of await readdir(dir).catch(() => [] as string[]))
		files[name] = await readFile(join(dir, name), "utf8");
	return files;
}

const gradesPath = (dir: string) => join(dir, "grades.json");

async function readGrades(dir: string) {
	return ((await readJson(gradesPath(dir))) ?? {}) as Record<string, Grade>;
}

const findingsOf = (verdict: ReviewVerdict | null) => ({
	verdict: verdict?.verdict ?? null,
	failures: verdict?.failures ?? [],
	unmetRequirements: (verdict?.requirements ?? [])
		.filter((entry) => entry.met === false)
		.map((entry) =>
			entry.evidence
				? `${entry.requirement}: ${entry.evidence}`
				: entry.requirement,
		),
	notes: verdict?.notes ?? "",
});

if (flags.grade) {
	const dir = runDirectory();
	const selection = await readSelection();
	const records = latestLive(await readRecords(dir));
	const grades = await readGrades(dir);
	const prompts = join(dir, "grading");
	await mkdir(prompts, { recursive: true });
	const sheet = [
		"# Checker detection: blind grading sheet",
		"",
		'For each sample: read the hidden test failure and the reviewer\'s findings, then fill grades.json as { "<id>": { "label": "named_cause" | "other", "otherReal": true | false | null, "cause": "...", "reason": "..." } }. named_cause: a finding identifies the defect that made at least one hidden check fail, specifically.',
		"",
	];
	const pending: { id: string; prompt: string }[] = [];
	const failing = selection.samples
		.filter((sample) => sample.kind !== "control")
		.sort((a, b) => blindId(a.id).localeCompare(blindId(b.id)));
	for (const sample of failing) {
		const record = records.get(sample.id);
		const verdict = record?.verdict ?? null;
		if (!verdict || verdict.verdict === "pass") continue;
		const id = blindId(sample.id);
		const environment = await loadTaskEnvironment(
			flags.dataset as string,
			sample.task,
		);
		const prompt = gradingPrompt({
			instruction: environment.instruction,
			evidence: failureEvidence(await graderFiles(sample)),
			findings: findingsOf(verdict),
		});
		await writeFile(join(prompts, `${id}.txt`), `${prompt}\n`);
		sheet.push(`## ${id}`, "", "```", prompt, "```", "");
		if (!grades[id]) pending.push({ id, prompt });
	}
	await writeFile(join(dir, "grading-sheet.md"), `${sheet.join("\n")}\n`);
	console.log(
		`Grading sheet: ${join(dir, "grading-sheet.md")} (${pending.length} sample(s) without a grade in ${gradesPath(dir)}).`,
	);
	if (flags.live && pending.length) {
		// A separate model session per sample (never the checker): codex exec on
		// the host, read-only sandbox in an empty directory, structured answer.
		const scratch = await mkdtemp(join(tmpdir(), "checker-grade-"));
		const schema = join(scratch, "schema.json");
		await writeFile(schema, JSON.stringify(GRADE_SCHEMA));
		const empty = join(scratch, "empty");
		await mkdir(empty);
		for (const { id, prompt } of pending) {
			const out = join(scratch, `${id}.out`);
			try {
				execFileSync(
					"codex",
					[
						"exec",
						"-m",
						flags["grader-model"] as string,
						"-s",
						"read-only",
						"--skip-git-repo-check",
						"--ephemeral",
						"-C",
						empty,
						"--output-schema",
						schema,
						"-o",
						out,
						"-",
					],
					{
						input: prompt,
						stdio: ["pipe", "ignore", "pipe"],
						timeout: 600_000,
					},
				);
				const grade = parseGrade(await readFile(out, "utf8"));
				if (grade) {
					grades[id] = grade;
					await writeFile(
						gradesPath(dir),
						`${JSON.stringify(grades, null, 2)}\n`,
					);
				}
				console.log(`${id}: ${grade ? grade.label : "unparsed answer"}`);
			} catch (error) {
				console.warn(`${id}: grading failed: ${safe(error)}`);
			}
		}
		await rm(scratch, { recursive: true, force: true });
	}
	process.exit(0);
}

if (flags.report) {
	const dir = runDirectory();
	const selection = await readSelection();
	const all = await readRecords(dir);
	const records = latestLive(all);
	const grades = await readGrades(dir);
	const rows = selection.samples.map((sample) => {
		const record = records.get(sample.id);
		const verdict = record?.verdict?.verdict ?? null;
		const grade = grades[blindId(sample.id)] ?? null;
		return {
			sample,
			record,
			verdict,
			grade,
			outcome: outcomeOf({ kind: sample.kind, verdict, grade }),
		};
	});
	console.log(
		table([
			[
				"sample",
				"kind",
				"blind id",
				"verdict",
				"outcome",
				"findings",
				"agent s",
				"in tok",
				"out tok",
				"first finding / hidden cause",
			],
			...rows.map(({ sample, record, verdict, grade, outcome }) => [
				sample.id,
				sample.kind,
				blindId(sample.id),
				verdict ?? "-",
				outcome,
				String(record?.verdict?.failures.length ?? "-"),
				String(record?.agentSec ?? "-"),
				String(record?.inputTokens ?? "-"),
				String(record?.outputTokens ?? "-"),
				`${(record?.verdict?.failures[0] ?? "").slice(0, 60)}${grade ? ` / ${grade.cause.slice(0, 60)}` : ""}`,
			]),
		]),
	);
	const outcomes = (kind: Sample["kind"]) =>
		rows.filter((row) => row.sample.kind === kind).map((row) => row.outcome);
	console.log(
		`\n${formatRates("Failing runs (main sample)", failingRates(outcomes("failing")))}`,
	);
	console.log(
		formatRates(
			"Failing runs (held-out tasks)",
			failingRates(outcomes("held-out")),
		),
	);
	const controls = controlRates(outcomes("control"));
	console.log(
		`Passing controls: ${controls.n} sample(s), ${controls.ran} checked; false alarms (verdict fail) ${controls.falseAlarms}${controls.falseAlarmRate === null ? "" : ` (${Math.round(controls.falseAlarmRate * 100)}%)`}, unsure ${controls.unsure}.`,
	);
	const tokens = [...records.values()].reduce(
		(sum, record) =>
			sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
		0,
	);
	console.log(
		`Checker turns: ${records.size} live record(s), ${tokens} tokens in all.`,
	);
	for (const record of all.filter(
		(entry) => entry.errors.length || entry.restoreProblems.length,
	))
		console.log(
			`- ${record.sample} (${record.mode}): ${[...record.restoreProblems, ...record.errors].join(" | ").slice(0, 400)}`,
		);
	process.exit(0);
}

const seconds = (from: number) => Math.round((Date.now() - from) / 1000);

const ENVIRONMENT_NOTE = (workdir: string) =>
	`\n\n(Environment: your shell commands run inside the task's container, starting in ${workdir}. File tools reach the task's working directory directly; use the shell for files elsewhere.)`;
const PROMPT_SUFFIX =
	"\n\nWork directly in this environment: no plan proposal, child tasks, commits, pull requests or publishing.";

/** sha256 of the task's test and solution files (64 bytes and up), to prove none reached the checker. */
async function forbiddenHashes(environment: TaskEnvironment) {
	const hashes = new Set<string>();
	async function walk(path: string) {
		const info = await stat(path).catch(() => null);
		if (!info) return;
		if (info.isDirectory()) {
			for (const entry of await readdir(path)) await walk(join(path, entry));
			return;
		}
		if (info.isFile() && info.size >= 64 && info.size < 20 * 1024 * 1024)
			hashes.add(
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex"),
			);
	}
	await walk(join(environment.dir, "tests"));
	await walk(join(environment.dir, "solution"));
	return [...hashes];
}

/** The checker's brief for one sample: the shared review brief plus the runner's time and environment notes. */
function checkerText(
	environment: TaskEnvironment,
	workdir: string,
	restore: RestoreResult,
	budgetSec: number,
) {
	return `${independentReviewBrief({
		taskText: environment.instruction,
		checkout: workdir,
		changedFiles: restore.changedFiles,
		outsideFiles: outsideFiles(environment, workdir),
		scratch: CHECKER_SCRATCH,
	})}\n\nYou have about ${Math.max(1, Math.floor(budgetSec / 60))} minutes; answer with the JSON before then (no answer counts as unsure).${ENVIRONMENT_NOTE(workdir)}${PROMPT_SUFFIX}`;
}

function chosenSamples(selection: Selection): Sample[] {
	if (flags.samples)
		return flags.samples.split(",").map((id) => {
			const sample = selection.samples.find(
				(entry) => entry.id === id.trim() || entry.task === id.trim(),
			);
			if (!sample) throw new Error(`${id} is not a selected sample.`);
			return sample;
		});
	if (flags.chunk) {
		const chunk = chunksOf(selection.samples)[Number(flags.chunk) - 1];
		if (!chunk)
			throw new Error(
				`Unknown chunk ${flags.chunk}; see --list (${chunksOf(selection.samples).length} chunks).`,
			);
		return chunk;
	}
	throw new Error("Choose samples with --samples or --chunk.");
}

function newRecord(sample: Sample, mode: CheckRecord["mode"]): CheckRecord {
	return {
		...emptyRecord(`codex:${flags.model}`, sample.task),
		run: flags.run as string,
		sample: sample.id,
		kind: sample.kind,
		mode,
		startedAt: new Date().toISOString(),
		setupSec: 0,
		restoreSec: 0,
		agentSec: 0,
		agentBudgetSec: 0,
		workdir: null,
		restore: null,
		restoreProblems: [],
		brief: null,
		report: null,
		verdict: null,
		usageLimit: null,
		vmResources: null,
	};
}

function describeRestore(record: CheckRecord) {
	const restore = record.restore;
	if (!restore) return "not restored";
	return `restore ${record.restoreProblems.length ? `PROBLEMS: ${record.restoreProblems.join("; ")}` : "ok"} in ${record.restoreSec}s (${restore.artifacts.map((entry) => `#${entry.index} ${entry.state} ${entry.files} file(s)`).join(", ")}; ${restore.patches.map((patch) => `diff #${patch.index} ${patch.applied ? "applied" : "FAILED"}`).join(", ") || "no diff"}; ${restore.sidecars.map((sidecar) => `sidecar ${sidecar.service} ${sidecar.state}`).join(", ") || "no sidecar restarted"}; /tests ${restore.testsAbsent ? "absent" : "PRESENT"}, /solution ${restore.solutionAbsent ? "absent" : "PRESENT"}; ${restore.changedFiles.length} changed file(s)${restore.forbidden.length ? `; identical to a test/solution file: ${restore.forbidden.join(", ")}` : ""}; brief ${record.brief?.length ?? 0} chars)`;
}

/** Prepares the task container like the VM setup: git, python3, rg when missing, and a git baseline. */
const CONTAINER_PREP = `set -e
cd "$WD"
missing=""
for c in git python3 rg; do command -v $c >/dev/null 2>&1 || missing="$missing $c"; done
if [ -n "$missing" ]; then
  if command -v apt-get >/dev/null; then apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3 ripgrep >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null; then dnf install -y -q git python3 ripgrep >/dev/null 2>&1 || true
  elif command -v apk >/dev/null; then apk add -q git python3 ripgrep bash >/dev/null 2>&1 || true
  fi
fi
git config --system --add safe.directory "*" 2>/dev/null || true
if [ ! -d .git ]; then
  git init -q && git symbolic-ref HEAD refs/heads/evaluation-frozen
  printf '\\nnode_modules/\\n.next/\\n.ytimesy/\\n__pycache__/\\n' >> .git/info/exclude
  git add -A && git -c user.name='Evaluation fixture' -c user.email=evaluation@ytimesy.invalid commit -q --allow-empty -m 'Frozen benchmark environment'
fi
echo "PREP_OK $(id -u) git=$(command -v git)"
`;

const run = (
	command: string,
	args: string[],
	timeoutMs: number,
	input?: string,
) =>
	execFileSync(command, args, {
		encoding: "utf8",
		timeout: timeoutMs,
		input,
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});

/**
 * The dry run on the local Docker host: the task's pinned images under
 * Compose (sidecars included), the saved workspace restored into the main
 * container with the same restore script as on a VM, the checks that tests
 * and solution are absent, and the checker's brief built. No VM, no
 * database, no model call.
 */
async function localDryRun(
	sample: Sample,
	environment: TaskEnvironment,
): Promise<CheckRecord> {
	const record = newRecord(sample, "dry-run");
	const started = Date.now();
	const root = join(dataDir, "local", sample.id);
	const project = `ckd-${createHash("sha256").update(sample.id).digest("hex").slice(0, 10)}`;
	const main = `${project}-main`;
	const composeArgs = [
		"compose",
		"-p",
		project,
		"-f",
		join(root, "compose.json"),
		"-f",
		join(root, "override.yaml"),
	];
	try {
		await rm(root, { recursive: true, force: true });
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "compose.json"),
			JSON.stringify(environment.compose),
		);
		await writeFile(
			join(root, "override.yaml"),
			`services:\n  main:\n    container_name: ${main}\n    command: ["sh", "-c", "sleep infinity"]\n`,
		);
		run(
			"docker",
			[...composeArgs, "up", "-d", "--wait", "--wait-timeout", "600"],
			1_800_000,
		);
		const workdir =
			run(
				"docker",
				[
					"image",
					"inspect",
					"-f",
					"{{.Config.WorkingDir}}",
					environment.envImage,
				],
				30_000,
			).trim() || "/app";
		record.workdir = workdir === "/" ? "/app" : workdir;
		const prep = run(
			"docker",
			[
				"exec",
				"-u",
				"0",
				"-e",
				`WD=${record.workdir}`,
				main,
				"sh",
				"-c",
				CONTAINER_PREP,
			],
			600_000,
		);
		if (!prep.includes("PREP_OK"))
			throw new Error(`Container prep failed: ${prep.slice(-400)}`);
		record.setupSec = seconds(started);
		const restoreStarted = Date.now();
		await writeFile(
			join(root, "runtime.sh"),
			`WD=${shellQuote(record.workdir)}\nMOUNTS=''\nMAIN=${shellQuote(main)}\nPROJECT=${shellQuote(project)}\n`,
		);
		await cp(
			join(sampleDir(sample), "workspace.tgz"),
			join(root, "workspace.tgz"),
		);
		await writeFile(
			join(root, "forbidden.sha256"),
			`${(await forbiddenHashes(environment)).join("\n")}\n`,
		);
		await writeFile(join(root, "restore.sh"), restoreScript(environment, root));
		const log = run(
			"bash",
			["-c", `bash ${shellQuote(join(root, "restore.sh"))} 2>&1`],
			600_000,
		);
		record.restoreLog = log.slice(-4000);
		record.restoreSec = seconds(restoreStarted);
		record.restore = parseRestoreLog(log);
		record.restoreProblems = restoreProblems(environment, record.restore);
		record.agentBudgetSec = Math.round(Number(flags["agent-minutes"]) * 60);
		record.brief = checkerText(
			environment,
			record.workdir,
			record.restore,
			record.agentBudgetSec,
		);
		record.state = record.restoreProblems.length
			? "restore-problem"
			: "dry-run";
	} catch (error) {
		record.errors.push(safe(error));
		record.state = "error";
	} finally {
		try {
			run(
				"docker",
				[...composeArgs, "down", "-v", "--remove-orphans", "-t", "5"],
				300_000,
			);
		} catch (error) {
			record.errors.push(`Compose down: ${safe(error)}`);
		}
		await rm(join(root, "workspace.tgz"), { force: true });
	}
	return record;
}

// ----------------------------------------------------------------------------
// --dry-run / --live: one checker run per sample in the task's environment.

const live = !!flags.live;
if (live === !!flags["dry-run"])
	throw new Error(
		"Pass exactly one of --dry-run (no model calls) or --live (Codex subscription).",
	);
if (flags.local) {
	if (live) throw new Error("--local is a dry run only (no model calls).");
	const selection = await readSelection();
	const chosen = chosenSamples(selection);
	const runDir = runDirectory();
	await mkdir(runDir, { recursive: true });
	const existing = await readRecords(runDir);
	for (const sample of chosen) {
		const attempt = String(
			existing.filter((record) => record.sample === sample.id).length + 1,
		);
		const record = await localDryRun(
			sample,
			await loadTaskEnvironment(flags.dataset as string, sample.task),
		);
		await writeFile(
			join(runDir, `${sample.id}.${attempt}.json`),
			`${JSON.stringify(record, null, 2)}\n`,
		);
		console.info(
			`${sample.id}: ${record.state}; ${describeRestore(record)}${record.errors.length ? `; errors: ${record.errors.join(" | ").slice(0, 400)}` : ""}`,
		);
	}
	console.log(`Records: ${runDir}`);
	process.exit(0);
}
const maxMinutes = Number(flags["max-minutes"]);
if (!(maxMinutes > 0 && maxMinutes <= 10))
	throw new Error("--max-minutes must be in (0, 10]: the owner's limit.");
const invocationStart = Date.now();
const invocationDeadline = invocationStart + maxMinutes * 60_000;
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const vms = taskVms(apiKey);
const { client, machines } = vms;
const runDir = runDirectory();
await mkdir(runDir, { recursive: true });
const selection = await readSelection();
const chosen = chosenSamples(selection);
const requestedAgentSeconds = Math.round(Number(flags["agent-minutes"]) * 60);
if (!(requestedAgentSeconds >= 60))
	throw new Error("--agent-minutes must be at least 1.");
const concurrency = Math.max(
	1,
	Math.min(SLOT_LIMITS.codex, Number(flags.concurrency) || chosen.length),
);
const model = flags.model as string;
if (!/^[a-z0-9._-]+$/.test(model)) throw new Error("Unexpected model id.");
await assertDevelopmentDatabase();

process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;

let stopping = false;
let usageLimitHit: string | null = null;
const liveCancels = new Set<() => Promise<void>>();
onEvalStop(() => {
	stopping = true;
});
const watchdog = setTimeout(
	() => {
		stopping = true;
		console.warn("Invocation ceiling reached; cancelling live runs.");
		void Promise.allSettled([...liveCancels].map((cancel) => cancel())).finally(
			() => setTimeout(() => process.exit(3), 60_000).unref(),
		);
	},
	invocationDeadline - Date.now() + 20_000,
);
watchdog.unref();

async function runSample(
	sample: Sample,
	environment: TaskEnvironment,
	attempt: string,
): Promise<CheckRecord> {
	const record = newRecord(sample, live ? "live" : "dry-run");
	const save = () =>
		writeFile(
			join(runDir, `${sample.id}.${attempt}.json`),
			`${JSON.stringify(record, null, 2)}\n`,
		);
	const started = Date.now();
	if (stopping) {
		record.state = "skipped";
		record.errors.push(usageLimitHit ?? "Run stopped before this sample.");
		await save();
		return record;
	}
	let user: EvalUser | undefined;
	let sessionId: string | undefined;
	let vm: string | undefined;
	const cancel = async () => {
		if (user && sessionId)
			await cancelServerTurn(user.userId, sessionId).catch(() => {});
	};
	liveCancels.add(cancel);
	try {
		user = await createEvalUser({
			label: `checker-detect ${sample.id}`,
			variant: harnessVariantFromFlags([]),
		});
		const owner = user;
		const session = await insertAgentSession({
			userId: user.userId,
			projectId: user.project.projectId,
			workspaceId: user.project.workspaceId,
			harness: "codex",
			title: `Checker ${sample.id}`,
			listedModelId: model,
		});
		sessionId = session.id;
		record.vmResources = await vms.createVm(
			`ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			"ytimesy-checker-detect",
			environment.cpus,
			environment.memoryMb,
			Math.ceil((invocationDeadline - Date.now()) / 1000) + 120,
			(vmId) => {
				vm = vmId;
				void owner.trackVm(vmId);
			},
		);
		const vmId = vm as string;
		await saveAgentSessionProviderRef(session.id, vmId);
		for (const [path, content] of Object.entries(
			setupFiles(environment, user.project.dirName),
		))
			await machines.writeTextFile(WorkspaceId(vmId), path, content);
		const setup = await vms.runDetached(
			vmId,
			"exec bash /tb/setup.sh\n",
			"setup-run",
			Math.min(
				300,
				Math.floor(
					(invocationDeadline - Date.now()) / 1000 - AFTER_CHECK_RESERVE_SEC,
				),
			),
		);
		record.setupSec = seconds(started);
		console.info(
			`${sample.id}: setup ${setup.exit === 0 ? "ok" : `FAILED (${setup.exit})`} in ${record.setupSec}s`,
		);
		if (setup.exit !== 0)
			throw new Error(`Environment setup failed: ${setup.log.slice(-1200)}`);
		// Restore the finished run's workspace; the tests and solution stay local.
		const restoreStarted = Date.now();
		await vms.uploadFile(
			vmId,
			join(sampleDir(sample), "workspace.tgz"),
			"/tb/workspace.tgz",
		);
		await client.vms
			.ref(vmId)
			.fs.writeFile(
				"/tb/forbidden.sha256",
				new TextEncoder().encode(
					`${(await forbiddenHashes(environment)).join("\n")}\n`,
				),
			);
		const restored = await vms.runDetached(
			vmId,
			restoreScript(environment),
			"restore",
			180,
		);
		record.restoreSec = seconds(restoreStarted);
		record.restore = parseRestoreLog(restored.log);
		record.restoreLog = restored.log.slice(-4000);
		record.restoreProblems = restoreProblems(environment, record.restore);
		record.workdir = (await vms.execOk(vmId, "cat /tb/workdir", 15_000)).trim();
		console.info(`${sample.id}: ${describeRestore(record)}`);
		if (record.restoreProblems.length)
			throw new Error(
				`Restore unfit for a check: ${record.restoreProblems.join("; ")}`,
			);
		const agentSeconds = Math.min(
			requestedAgentSeconds,
			(HARD_SET.find((task) => task.id === sample.task)?.maxAgentMinutes ??
				Number.POSITIVE_INFINITY) * 60,
		);
		const agentStarted = Date.now();
		const agentDeadline = Math.min(
			agentStarted + agentSeconds * 1000,
			invocationDeadline - AFTER_CHECK_RESERVE_SEC * 1000,
		);
		record.agentBudgetSec = Math.max(
			0,
			Math.round((agentDeadline - agentStarted) / 1000),
		);
		record.brief = checkerText(
			environment,
			record.workdir,
			record.restore,
			record.agentBudgetSec,
		);
		if (!live) {
			record.state = "dry-run";
		} else {
			if (record.agentBudgetSec < 120)
				throw new Error("Setup left under two minutes for the checker.");
			await database().query(
				"update agent_session set status='ready' where id=$1",
				[session.id],
			);
			await withSlot(
				"codex",
				SLOT_LIMITS.codex,
				async () => {
					await withBackgroundJobDispatcher(
						async () => {},
						() =>
							sendSubscriptionTask(
								{
									userId: owner.userId,
									projectId: owner.project.projectId,
									sessionId: session.id,
								},
								{
									modelId: model,
									text: record.brief as string,
									variant: flags.reasoning,
								},
							),
					);
					let admitted = false;
					while (
						!admitted &&
						Date.now() < agentStarted + 120_000 &&
						!stopping
					) {
						const turn = await claimApiTurn(
							concurrency,
							64,
							"durable-object",
							session.id,
						);
						if (turn?.lease_id) {
							await dispatchModelWorkflow(turn);
							admitted = true;
							break;
						}
						const state = await turnState(session.id);
						if (state && state.state !== "queued") admitted = true;
						else await delay(2000);
					}
					if (!admitted)
						throw new Error("Turn was not admitted within two minutes.");
					let cancelSent = false;
					while (true) {
						const state = await turnState(session.id);
						const items = sessionItemsFromUnknown(state?.items);
						measureRun(record, items, state?.messages, () => 0);
						record.state = state?.state ?? "missing";
						const failure = JSON.stringify(
							items.filter((item) => item.kind === "error"),
						);
						if (USAGE_LIMIT.test(failure)) {
							record.usageLimit =
								/Your ChatGPT plan's Codex usage limit[^"]*/.exec(
									failure,
								)?.[0] ?? "Codex usage limit reached";
							usageLimitHit = record.usageLimit;
							stopping = true;
						}
						if (state && !["queued", "running"].includes(state.state)) break;
						const reason =
							Date.now() > agentDeadline
								? `checker time limit (${record.agentBudgetSec}s)`
								: stopping
									? "run stopped"
									: null;
						if (reason && !cancelSent) {
							cancelSent = true;
							record.errors.push(`Cancelled: ${reason}.`);
							await cancelServerTurn(owner.userId, session.id);
						}
						if (Date.now() > agentDeadline + 30_000) {
							record.state = "unsettled";
							break;
						}
						await delay(3000);
					}
					const state = await turnState(session.id);
					const items = sessionItemsFromUnknown(state?.items);
					record.report = lastAgentMessageText(items);
					if (flags.transcripts)
						await writeFile(
							join(runDir, `${sample.id}.${attempt}.transcript.txt`),
							JSON.stringify(
								{ items: state?.items, messages: state?.messages },
								null,
								1,
							),
						).catch(() => {});
				},
				() => stopping,
			);
			record.completed = record.state === "completed";
			record.verdict = parseReviewVerdict(record.report ?? "");
			if (record.usageLimit) throw new Error(record.usageLimit);
		}
		record.agentSec = live ? seconds(agentStarted) : 0;
	} catch (error) {
		record.errors.push(safe(error));
		if (record.state === "not-started") record.state = "error";
	} finally {
		liveCancels.delete(cancel);
		await cancel();
		if (vm) await client.vms.delete(vm).catch(() => {});
		if (user && sessionId)
			await deleteAgentSessionForOwner(user.userId, sessionId).catch(() => {});
		if (user) {
			const leaked = await user.release();
			if (leaked.length)
				record.errors.push(`Cleanup left: ${leaked.join(", ")}`);
		}
	}
	await save();
	console.info(
		`${sample.id}: ${record.mode} ${record.state}${record.verdict ? ` verdict=${record.verdict.verdict} findings=${record.verdict.failures.length}` : ""} checker=${record.agentSec}s/${record.agentBudgetSec}s total=${seconds(started)}s${record.errors.length ? ` errors=${record.errors.join(" | ").slice(0, 300)}` : ""}`,
	);
	return record;
}

const environments = new Map<string, TaskEnvironment>();
for (const sample of chosen) {
	if (!existsSync(join(sampleDir(sample), "workspace.tgz")))
		throw new Error(`${sample.id}: no bundle; run --prepare.`);
	environments.set(
		sample.id,
		await loadTaskEnvironment(flags.dataset as string, sample.task),
	);
}
if (live) await preflightExecutor();
const ownerId = live ? await subscriptionOwner() : null;
const usageBefore = ownerId ? await codexUsage(ownerId) : null;
console.info(
	`Checker detection ${flags.run}: ${chosen.length} sample(s), ${live ? `live, model ${model}${flags.reasoning ? ` (${flags.reasoning})` : ""}` : "dry run (no model calls)"}, checker ${requestedAgentSeconds}s, ceiling ${maxMinutes} min, concurrency ${concurrency}.${usageBefore ? ` Codex usage before: ${usageBefore}.` : ""}`,
);
if (usageBefore?.includes("LIMIT REACHED"))
	throw new Error("Codex usage limit already reached; not starting.");
const existing = await readRecords(runDir);
const attemptFor = (id: string) => {
	const used = existing.filter((record) => record.sample === id).length;
	existing.push({ sample: id } as CheckRecord);
	return String(used + 1);
};
const queue = chosen.map((sample) => ({
	sample,
	attempt: attemptFor(sample.id),
}));
const records: CheckRecord[] = [];
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length) {
			const next = queue.shift() as (typeof queue)[number];
			records.push(
				await runSample(
					next.sample,
					environments.get(next.sample.id) as TaskEnvironment,
					next.attempt,
				),
			);
		}
	}),
);
clearTimeout(watchdog);
const usageAfter = ownerId ? await codexUsage(ownerId) : null;
await closeDatabase();
console.log(
	table([
		[
			"sample",
			"kind",
			"state",
			"restore",
			"tests/solution",
			"changed",
			"verdict",
			"findings",
			"setup s",
			"restore s",
			"checker s",
			"budget s",
		],
		...records.map((record) => [
			record.sample,
			record.kind,
			record.state,
			record.restore ? (record.restoreProblems.length ? "PROBLEM" : "ok") : "-",
			record.restore
				? `${record.restore.testsAbsent ? "absent" : "PRESENT"}/${record.restore.solutionAbsent ? "absent" : "PRESENT"}`
				: "-",
			String(record.restore?.changedFiles.length ?? "-"),
			record.verdict?.verdict ?? "-",
			String(record.verdict?.failures.length ?? "-"),
			String(record.setupSec),
			String(record.restoreSec),
			String(record.agentSec),
			String(record.agentBudgetSec),
		]),
	]),
);
console.log(
	`Wall ${seconds(invocationStart)}s.${usageAfter ? ` Codex usage after: ${usageAfter}.` : ""}${usageLimitHit ? ` STOPPED on the Codex usage limit: ${usageLimitHit}` : ""}\nRecords: ${runDir} (${relative(process.cwd(), runDir)})`,
);
process.exit(0);
