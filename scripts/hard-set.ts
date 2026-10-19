// Development-only hard evaluation set (docs/hard-set.md): Terminal-Bench 4.0
// tasks run through the ytimesy builder on the development edge, one
// throwaway eval user and one workspace VM per task, the task's environment
// in Docker on that VM, and the task's own tests on a second (grader) VM.
// Not the official harness: never report its numbers as Terminal-Bench scores.
//
// node --env-file=.env --import tsx scripts/hard-set.ts --list
// node --env-file=.env --import tsx scripts/hard-set.ts --live --run <name> --chunk 1
// node --env-file=.env --import tsx scripts/hard-set.ts --collect --run <name>
// node --env-file=.env --import tsx scripts/hard-set.ts --report --run <name>
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
	type AttemptSnapshot,
	type AttemptVerdictKind,
	attemptLimit,
	attemptRef,
	checkerAccuracy,
	formatCheckerAccuracy,
	selectCandidate,
} from "../src/domain/attempt-loop";
import {
	attemptCostFromRun,
	formatCostSummary,
	runListPrice,
	costSummary as sharedCostSummary,
} from "../src/domain/eval-cost";
import {
	harnessVariantFromFlags,
	harnessVariantLabel,
} from "../src/domain/harness-variant";
import { WorkspaceId } from "../src/domain/ids";
import { modelBilling } from "../src/domain/model-pricing";
import { sessionItemsFromUnknown } from "../src/domain/session-item";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import {
	attemptLoopStates,
	reviewLoopStates,
	saveAttemptLoopDeadline,
} from "../src/server/adapters/attempt-loop-store";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../src/server/adapters/database";
import { dispatchModelWorkflow } from "../src/server/adapters/model-workflow-dispatch";
import {
	attemptLoopSpend,
	restoreSnapshotCommand,
} from "../src/server/services/attempt-loop";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";
import { captureConversationCode } from "../src/server/services/conversation-code-checkpoint";
import { reviewLoopSpend, reviewRef } from "../src/server/services/review-loop";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";
import {
	attemptSections,
	attemptsVerifyScript,
	graderPullScript,
	loadTaskEnvironment,
	oracleScript,
	parseReward,
	setupFiles,
	stageScript,
	type TaskEnvironment,
	verifyScript,
} from "./hard-set/environment";
import {
	type HardSetReviewRecord,
	reviewLoopReport,
} from "./hard-set/review-report";
import { HARD_SET, HARD_SET_CHUNKS, type HardSetTask } from "./hard-set/tasks";
import { codexUsage, preflightExecutor, sh, taskVms } from "./hard-set/vm";
import {
	assertDevelopmentDatabase,
	emptyRecord,
	measureRun,
	type RunRecord,
	safe,
	table,
	turnState,
} from "./smoke/builder-harness";
import {
	createEvalUser,
	type EvalUser,
	onEvalStop,
	SLOT_LIMITS,
	subscriptionOwner,
	withSlot,
} from "./smoke/eval-user";

const DEFAULT_DATASET = resolve("../cloud/.ytimesy/tb4-dataset");
const RUNS = resolve(".ytimesy/hard-set");
const USAGE_LIMIT = /usage limit is used up|usage_limit_reached/i;
// Wall-time reserve after the agent: cancel/settle, staging, artifact transfer.
const AFTER_AGENT_RESERVE_SEC = 75;
// A grader VM lives at most this long (its tests may outlast the invocation;
// --collect reads the result and deletes it).
const GRADER_LIFETIME_SEC = 45 * 60;

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		list: { type: "boolean", default: false },
		collect: { type: "boolean", default: false },
		report: { type: "boolean", default: false },
		/** Groups the chunks of one pass; results go to .ytimesy/hard-set/<run>/. */
		run: { type: "string" },
		tasks: { type: "string" },
		/** 1-based chunk number from HARD_SET_CHUNKS (comma-separated for several). */
		chunk: { type: "string" },
		/** agent (default), oracle (reference solution, expect 1) or nop (no agent, expect 0). */
		mode: { type: "string", default: "agent" },
		model: { type: "string", default: "gpt-6.1-sol" },
		/** Reasoning effort for the subscription turn; the model default when unset. */
		reasoning: { type: "string" },
		variant: { type: "string", multiple: true },
		/** Agent time per task (minutes). */
		"agent-minutes": { type: "string", default: "7" },
		/** Wall-time ceiling for this invocation (minutes, at most 10). */
		"max-minutes": { type: "string", default: "10" },
		/** Tasks run at once (default: all selected, at most the Codex slots). */
		concurrency: { type: "string" },
		dataset: { type: "string", default: DEFAULT_DATASET },
		/** Keep each agent run's stored items and model messages (run directory). */
		transcripts: { type: "boolean", default: false },
	},
});

// Cost comes from the shared eval-cost helper (src/domain/eval-cost.ts) at
// the model's list price in src/domain/model-pricing.ts. Our runs use the
// Codex subscription, so it is what the same tokens would cost on the API,
// labelled as an estimate, not what the run cost.

/** API cost of a record's tokens at list price; null without tokens or a price. */
function estimatedCost(record: HardSetRecord) {
	if (record.inputTokens === null || record.inputTokens === undefined)
		return null;
	return runListPrice({
		harness: "codex",
		modelId: record.model,
		inputTokens: record.inputTokens,
		cachedTokens: record.cachedTokens ?? null,
		outputTokens: record.outputTokens ?? null,
	}).costUsd;
}

const usd = (value: number | null) =>
	value === null ? "-" : `$${value.toFixed(value < 1 ? 3 : 2)}`;

/**
 * Cost per attempt and per solved task over scored agent records. With the
 * attempt loop a run also pays for its checkers and judge (their own
 * sessions), so those tokens and dollars are added to the builder's.
 */
function costSummary(records: HardSetRecord[]) {
	const attempts = records
		.filter((record) => estimatedCost(record) !== null)
		.map((record) => {
			const base = attemptCostFromRun({
				...record,
				verifierPassed: record.passed,
			});
			const builder = estimatedCost(record);
			const loop = record.attemptLoop ?? record.reviewLoop;
			return {
				...base,
				tokens: base.tokens + (loop?.extraTokens ?? 0),
				costUsd:
					builder === null || (loop && loop.extraCostUsd === null)
						? null
						: builder + (loop?.extraCostUsd ?? 0),
				agents: base.agents + (loop?.checkers ?? 0),
				estimated: true,
			};
		});
	if (!attempts.length) return null;
	return `Cost: ${formatCostSummary(sharedCostSummary(attempts))}.`;
}

const seconds = (from: number) => Math.round((Date.now() - from) / 1000);

type HardSetRecord = RunRecord & {
	run: string;
	attempt: string;
	category: string;
	mode: string;
	variant: string;
	reasoning: string | null;
	startedAt: string;
	reward: number | null;
	passed: boolean;
	/** final, grading (tests still running on graderVmId), or error. */
	status: "final" | "grading" | "error";
	setupSec: number;
	agentSec: number;
	agentBudgetSec: number;
	agentRequestedSec: number;
	stageSec: number;
	gradeSec: number;
	testsExit: number | null;
	testsTail: string;
	gradeError: string | null;
	usageLimit: string | null;
	vmResources: string | null;
	graderVmId: string | null;
	gradeStartedAt: string | null;
	gradeTimeoutSec: number | null;
	/** attempts=3: the loop's attempts, checker verdicts and per-attempt grades. */
	attemptLoop?: HardSetLoopRecord | null;
	/** review=on: the review rounds, checker verdicts and the grade of each checked tree. */
	reviewLoop?: HardSetReviewRecord | null;
};

type HardSetLoopAttempt = {
	n: number;
	verdict: AttemptVerdictKind | null;
	findings: string[];
	cutOff: boolean;
	tree: string;
	ref: string;
	snapshot: AttemptSnapshot;
	tokens: number;
	costUsd: number | null;
	minutes: number;
	/** The grader's result for this attempt's candidate (the final grade when it is the kept tree). */
	graderReward: number | null;
	graderPassed: boolean | null;
	/** Its tree is the one graded as the run's result (it shares that grade). */
	sameAsFinal: boolean;
	/** The artifacts staged for this attempt (/tb/<name>.tgz), when it was not the final tree. */
	gradeName: string | null;
};

type HardSetLoopRecord = {
	phase: string;
	kept: number | null;
	selection: string | null;
	attempts: HardSetLoopAttempt[];
	/** Checker and judge spend on top of the builder's turn. */
	extraTokens: number;
	extraCostUsd: number | null;
	checkers: number;
	finalTree: string | null;
	branch: string;
	/** The runner restored this attempt because the loop did not finish in time. */
	runnerRestored: number | null;
	attemptGrading: "none" | "grading" | "final";
	notes: string[];
};

function selectedTasks(): HardSetTask[] {
	if (flags.tasks && flags.chunk)
		throw new Error("Pass --tasks or --chunk, not both.");
	const ids = flags.tasks
		? flags.tasks.split(",").map((id) => id.trim())
		: flags.chunk
			? flags.chunk.split(",").flatMap((value) => {
					const chunk = HARD_SET_CHUNKS[Number(value) - 1];
					if (!chunk)
						throw new Error(
							`Unknown chunk ${value}; choose 1-${HARD_SET_CHUNKS.length}.`,
						);
					return chunk;
				})
			: null;
	if (!ids)
		throw new Error("Choose tasks with --tasks or --chunk (see --list).");
	return ids.map((id) => {
		const task = HARD_SET.find((candidate) => candidate.id === id);
		if (!task)
			throw new Error(
				`${id} is not in the hard set; see --list (scripts/hard-set/tasks.ts).`,
			);
		return task;
	});
}

function runDirectory() {
	const run = flags.run;
	if (!run || !/^[A-Za-z0-9._=-]{1,80}$/.test(run))
		throw new Error(
			"Pass --run <name> (letters, digits, . _ = -): one name per pass, shared by its chunks.",
		);
	return join(RUNS, run);
}

async function readRecords(dir: string) {
	const files = (await readdir(dir).catch(() => [] as string[])).filter(
		(file) => file.endsWith(".json") && !file.endsWith(".transcript.json"),
	);
	return Promise.all(
		files.map(
			async (file) =>
				JSON.parse(await readFile(join(dir, file), "utf8")) as HardSetRecord,
		),
	);
}

const saveRecord = (dir: string, record: HardSetRecord) =>
	writeFile(
		join(dir, `${record.task}.${record.attempt}.json`),
		`${JSON.stringify(record, null, 2)}\n`,
	);

function printTable(records: HardSetRecord[]) {
	console.log(
		table([
			[
				"task",
				"cat",
				"pass",
				"reward",
				"state",
				"agent s",
				"budget s",
				"setup s",
				"grade s",
				"in tok",
				"out tok",
				"cached",
				"steps",
				"tools",
				"est $",
			],
			...records.map((record) => [
				`${record.task}.${record.attempt}`,
				record.category,
				record.status === "grading" ? "..." : record.passed ? "PASS" : "fail",
				record.reward === null ? "-" : String(record.reward),
				record.usageLimit
					? "usage-limit"
					: record.status === "grading"
						? "grading"
						: record.state,
				String(record.agentSec),
				String(record.agentBudgetSec),
				String(record.setupSec),
				String(record.gradeSec),
				String(record.inputTokens ?? "-"),
				String(record.outputTokens ?? "-"),
				String(record.cachedTokens ?? "-"),
				String(record.modelSteps ?? "-"),
				String(record.toolCalls),
				usd(estimatedCost(record)),
			]),
		]),
	);
}

/** Scored = graded, not skipped, not stopped by the usage limit, full agent budget. */
const isScored = (record: HardSetRecord) =>
	record.status === "final" &&
	record.state !== "skipped" &&
	!record.usageLimit &&
	record.reward !== null &&
	record.agentBudgetSec >= record.agentRequestedSec - 30;

/** The attempt loop's per-attempt lines and the checker's accuracy against the grader. */
function printAttemptLoops(records: HardSetRecord[]) {
	const loops = records.filter((record) => record.attemptLoop);
	if (!loops.length) return;
	console.log("\nAttempt loop (checker verdict -> grader):");
	for (const record of loops) {
		const loop = record.attemptLoop as HardSetLoopRecord;
		console.log(
			`- ${record.task}.${record.attempt}: ${loop.attempts
				.map(
					(attempt) =>
						`#${attempt.n} ${attempt.verdict ?? (attempt.cutOff ? "cut-off" : "unchecked")}->${attempt.graderPassed === null ? "?" : attempt.graderPassed ? "PASS" : "fail"} ${attempt.minutes.toFixed(1)}m`,
				)
				.join(
					", ",
				)}; kept ${loop.kept ?? "-"}${loop.runnerRestored ? ` (runner restored ${loop.runnerRestored})` : ""}${loop.selection ? `; ${loop.selection}` : ""}${loop.attemptGrading === "grading" ? "; attempt grades pending (--collect)" : ""}`,
		);
	}
	const rows = loops.flatMap((record) =>
		(record.attemptLoop as HardSetLoopRecord).attempts.flatMap((attempt) =>
			attempt.verdict && attempt.graderPassed !== null
				? [{ verdict: attempt.verdict, graderPassed: attempt.graderPassed }]
				: [],
		),
	);
	if (rows.length) console.log(formatCheckerAccuracy(checkerAccuracy(rows)));
}

/**
 * The loop's record after the turn: per attempt the checker's verdict, spend
 * and candidate. When the loop did not finish before the runner's cancel,
 * the best checked candidate is restored (the loop's own rule without
 * suites), so the grader sees what the loop would have kept.
 */
async function readAttemptLoop(
	sessionId: string,
	vm: string,
): Promise<HardSetLoopRecord | null> {
	const state = (await attemptLoopStates(sessionId)).at(-1);
	if (!state) return null;
	const cwd = state.checkpoint.cwd;
	const workspace = { machines, vm: WorkspaceId(vm), cwd };
	const branch = (
		await machines.exec(
			WorkspaceId(vm),
			`git -C ${sh(cwd)} symbolic-ref -q HEAD || true`,
			15_000,
		)
	).stdout.trim();
	const notes: string[] = [];
	let final = await captureConversationCode(
		workspace,
		attemptRef(state.turnId, "final"),
	).catch((error: unknown) => {
		notes.push(`Final tree not captured: ${safe(error).slice(0, 200)}`);
		return null;
	});
	let runnerRestored: number | null = null;
	if (state.phase !== "done" && state.candidates.length) {
		const inProgress =
			final && !state.candidates.some((c) => c.snapshot.tree === final?.tree)
				? [
						{
							n: state.attempt,
							verdict: null,
							ownPassRate: null,
							cutOff: true,
							tree: final.tree,
						},
					]
				: [];
		const best = selectCandidate(
			[
				...state.candidates.map((candidate) => ({
					n: candidate.n,
					verdict: candidate.verdict?.verdict ?? null,
					ownPassRate: candidate.verdict?.tests.length
						? candidate.verdict.tests.filter((test) => test.passed).length /
							candidate.verdict.tests.length
						: null,
					cutOff: candidate.cutOff,
					tree: candidate.snapshot.tree,
				})),
				...inProgress,
			],
			[],
		).best;
		const chosen = state.candidates.find((candidate) => candidate.n === best);
		if (
			chosen &&
			chosen.snapshot.tree !== final?.tree &&
			!inProgress.some((c) => c.n === best)
		) {
			const restored = await machines.exec(
				WorkspaceId(vm),
				restoreSnapshotCommand(chosen.snapshot, branch),
				60_000,
			);
			if (restored.exitCode === 0) {
				runnerRestored = chosen.n;
				final = chosen.snapshot;
			} else notes.push(`Restore of attempt ${chosen.n} failed.`);
		}
		notes.push(
			`The loop stopped in phase ${state.phase} at the runner's cancel.`,
		);
	}
	const spend = attemptLoopSpend(
		state,
		modelBilling({ harness: "codex", modelId: model }),
	);
	const extra = spend.attempts.reduce(
		(sum, attempt) => ({
			tokens: sum.tokens + attempt.checker.tokens,
			costUsd:
				sum.costUsd === null || attempt.checker.costUsd === null
					? null
					: sum.costUsd + attempt.checker.costUsd,
		}),
		{ tokens: spend.judge.tokens, costUsd: spend.judge.costUsd },
	);
	return {
		phase: state.phase,
		kept: runnerRestored ?? state.kept ?? null,
		selection: state.selection?.explanation ?? null,
		attempts: state.candidates.map((candidate) => {
			const attemptSpend = spend.attempts.find((a) => a.n === candidate.n);
			return {
				n: candidate.n,
				verdict: candidate.verdict?.verdict ?? null,
				findings: (candidate.verdict?.failures ?? []).slice(0, 5),
				cutOff: candidate.cutOff,
				tree: candidate.snapshot.tree,
				ref: candidate.snapshot.ref,
				snapshot: candidate.snapshot,
				tokens: attemptSpend?.total.tokens ?? 0,
				costUsd: attemptSpend?.total.costUsd ?? null,
				minutes: (attemptSpend?.ms ?? 0) / 60_000,
				graderReward: null,
				graderPassed: null,
				sameAsFinal: !!final && candidate.snapshot.tree === final.tree,
				// Identical trees share one grade.
				gradeName:
					final && candidate.snapshot.tree === final.tree
						? null
						: `artifacts-a${
								state.candidates.find(
									(other) => other.snapshot.tree === candidate.snapshot.tree,
								)?.n ?? candidate.n
							}`,
			};
		}),
		extraTokens: extra.tokens,
		extraCostUsd: extra.costUsd,
		checkers:
			state.candidates.filter((c) => c.checker).length +
			(state.selection?.judge ? 1 : 0),
		finalTree: final?.tree ?? null,
		branch,
		runnerRestored,
		attemptGrading: "none",
		notes: [...notes, ...(state.selection?.notes ?? [])],
	};
}

/**
 * The review loop's record after the turn: per round the checker's verdict,
 * findings, the builder's answers and spend, and the tree it checked (graded
 * on its own when it is not the final tree, so a fail -> fix -> pass shows).
 */
async function readReviewLoop(
	sessionId: string,
	vm: string,
): Promise<HardSetReviewRecord | null> {
	const state = (await reviewLoopStates(sessionId)).at(-1);
	if (!state) return null;
	const cwd = state.checkpoint.cwd;
	const workspace = { machines, vm: WorkspaceId(vm), cwd };
	const branch = (
		await machines.exec(
			WorkspaceId(vm),
			`git -C ${sh(cwd)} symbolic-ref -q HEAD || true`,
			15_000,
		)
	).stdout.trim();
	const notes: string[] = [];
	const final = await captureConversationCode(
		workspace,
		reviewRef(state.turnId, "final"),
	).catch((error: unknown) => {
		notes.push(`Final tree not captured: ${safe(error).slice(0, 200)}`);
		return null;
	});
	if (state.phase !== "done")
		notes.push(
			`The loop stopped in phase ${state.phase} at the runner's cancel.`,
		);
	const spend = reviewLoopSpend(
		state,
		modelBilling({ harness: "codex", modelId: model }),
	);
	return {
		phase: state.phase,
		outcome: state.outcome ?? null,
		note: state.note ?? null,
		rounds: state.rounds.map((round) => {
			const roundSpend = spend.rounds.find((entry) => entry.n === round.n);
			const sameAsFinal = !!final && round.snapshot.tree === final.tree;
			const firstSame =
				state.rounds.find(
					(other) => other.snapshot.tree === round.snapshot.tree,
				)?.n ?? round.n;
			const responses = round.fix?.responses;
			return {
				n: round.n,
				verdict: round.verdict?.verdict ?? null,
				timedOut: !!round.timedOut,
				truncated: !!round.verdict?.truncated,
				findings: round.findings.length,
				findingTexts: round.findings
					.slice(0, 5)
					.map((finding) => `${finding.id} ${finding.text.slice(0, 200)}`),
				decision: round.decision ?? null,
				checkerTokens: roundSpend?.checker.tokens ?? 0,
				checkerCostUsd: roundSpend?.checker.costUsd ?? null,
				checkMinutes: (roundSpend?.checkMs ?? 0) / 60_000,
				fixTokens: roundSpend?.fix.tokens ?? 0,
				fixCostUsd: roundSpend?.fix.costUsd ?? null,
				fixMinutes: (roundSpend?.fixMs ?? 0) / 60_000,
				fixed: responses?.fixed.length ?? 0,
				rejected: responses?.rejected.length ?? 0,
				unanswered: responses?.unanswered.length ?? 0,
				tree: round.snapshot.tree,
				snapshot: round.snapshot,
				sameAsFinal,
				gradeName: sameAsFinal ? null : `artifacts-r${firstSame}`,
				graderReward: null,
				graderPassed: null,
			};
		}),
		extraTokens: spend.checker.tokens,
		extraCostUsd: spend.checker.costUsd,
		checkers: state.rounds.length,
		finalTree: final?.tree ?? null,
		branch,
		attemptGrading: "none",
		notes,
	};
}

if (flags.list) {
	const rows = [["chunk", "task", "category", "tb4 ours", "codex", "bucket"]];
	HARD_SET_CHUNKS.forEach((chunk, index) => {
		for (const id of chunk) {
			const task = HARD_SET.find((candidate) => candidate.id === id);
			if (!task) throw new Error(`Chunk lists unknown task ${id}.`);
			rows.push([
				String(index + 1),
				id,
				task.category,
				`${task.tb4.passes}/${task.tb4.trials}`,
				`${task.codex.passes}/${task.codex.trials}`,
				task.bucket.slice(0, 70),
			]);
		}
	});
	console.log(table(rows));
	process.exit(0);
}

if (flags.report) {
	const dir = runDirectory();
	const records = (await readRecords(dir)).sort((a, b) =>
		`${a.task}.${a.attempt}`.localeCompare(`${b.task}.${b.attempt}`),
	);
	printTable(records);
	const scored = records.filter(isScored);
	const byCategory = (category: string) => {
		const list = scored.filter((record) => record.category === category);
		return `${category} ${list.filter((record) => record.passed).length}/${list.length}`;
	};
	console.log(
		`\nRun ${flags.run}: ${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed (${byCategory("hard")}, ${byCategory("time-pressure")}, ${byCategory("control")}); ${records.length - scored.length} not scored (grading, skipped, usage limit, short budget or no reward).`,
	);
	const cost = costSummary(scored.filter((record) => record.mode === "agent"));
	if (cost) console.log(cost);
	printAttemptLoops(records);
	for (const line of reviewLoopReport(records)) console.log(line);
	for (const record of records.filter((record) => !isScored(record)))
		console.log(
			`- ${record.task}.${record.attempt}: ${record.status} ${record.state} budget ${record.agentBudgetSec}/${record.agentRequestedSec}s ${[...record.errors, record.gradeError].filter(Boolean).join(" | ").slice(0, 300)}`,
		);
	process.exit(0);
}

const maxMinutes = Number(flags["max-minutes"]);
if (!(maxMinutes > 0 && maxMinutes <= 10))
	throw new Error("--max-minutes must be in (0, 10]: the owner's limit.");
const invocationStart = Date.now();
const invocationDeadline = invocationStart + maxMinutes * 60_000;
// Grader VMs belong to no user, so the local VM calls skip usage admission
// (as the smoke suite's do); the edge still admits the agent VMs it uses.
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const {
	client,
	machines,
	execOk,
	startDetached,
	waitDetached,
	runDetached,
	uploadDirectory,
	createVm,
} = taskVms(apiKey);
const runDir = runDirectory();
await mkdir(runDir, { recursive: true });

/** Reads a grader VM's result into its record; deletes the VM once read. */
async function finishGrading(record: HardSetRecord, until: number) {
	const vm = record.graderVmId as string;
	if (!vm) return record;
	if (record.status === "grading") {
		const done = await waitDetached(vm, "verify", until).catch(
			(error: unknown) => ({ exit: -1, log: `GRADE_ERROR ${safe(error)}` }),
		);
		const started = Date.parse(record.gradeStartedAt ?? "") || Date.now();
		if (!done) {
			// Give up only when the grader answers and still has no result long
			// after its timeout; an unreachable VM (our network, a sleeping
			// laptop) stays pending for the next --collect.
			const reachable = await machines
				.exec(WorkspaceId(vm), "test -f /tb/verify.sh", 15_000)
				.then((result) => result.exitCode === 0)
				.catch(() => false);
			if (
				reachable &&
				Date.now() - started > ((record.gradeTimeoutSec ?? 900) + 300) * 1000
			) {
				record.status = "error";
				record.gradeError = "Grader never finished.";
				if (record.attemptLoop) record.attemptLoop.attemptGrading = "none";
				if (record.reviewLoop) record.reviewLoop.attemptGrading = "none";
				await client.vms.delete(vm).catch(() => {});
				record.graderVmId = null;
			}
			return record;
		}
		const parsed = parseReward(done.log);
		record.gradeSec = Math.round((Date.now() - started) / 1000);
		record.reward = parsed.reward;
		record.testsExit = parsed.testsExit;
		record.testsTail = parsed.tail.slice(-800);
		record.gradeError =
			parsed.error ??
			(parsed.reward === null
				? `no reward (grader exit ${done.exit}): ${safe(done.log.slice(-400))}`
				: null);
		record.passed = parsed.reward === 1;
		record.verifierPassed = record.passed;
		record.status = "final";
		// Attempts and checked trees that are the graded one share its result.
		for (const attempt of [
			...(record.attemptLoop?.attempts ?? []),
			...(record.reviewLoop?.rounds ?? []),
		])
			if (attempt.sameAsFinal && parsed.reward !== null) {
				attempt.graderReward = parsed.reward;
				attempt.graderPassed = parsed.reward === 1;
			}
	}
	const loop = record.attemptLoop ?? record.reviewLoop;
	if (loop?.attemptGrading === "grading") {
		const done = await waitDetached(vm, "verify-attempts", until).catch(
			() => null,
		);
		if (!done) return record;
		const sections = attemptSections(done.log);
		for (const attempt of "attempts" in loop ? loop.attempts : loop.rounds) {
			if (!attempt.gradeName) continue;
			const section = sections.get(attempt.gradeName);
			const reward = section ? parseReward(section).reward : null;
			attempt.graderReward = reward;
			attempt.graderPassed = reward === null ? null : reward === 1;
		}
		loop.attemptGrading = "final";
	}
	await client.vms.delete(vm).catch(() => {});
	record.graderVmId = null;
	return record;
}

if (flags.collect) {
	// Reads the result of every grader still running for this run.
	const pending = (await readRecords(runDir)).filter(
		(record) =>
			record.status === "grading" ||
			record.attemptLoop?.attemptGrading === "grading" ||
			record.reviewLoop?.attemptGrading === "grading",
	);
	console.info(`Collecting ${pending.length} grading run(s) in ${runDir}.`);
	await Promise.all(
		pending.map(async (record) => {
			await finishGrading(record, invocationDeadline - 15_000);
			await saveRecord(runDir, record);
			console.info(
				`${record.task}.${record.attempt}: ${record.status === "grading" ? "still grading" : record.passed ? "PASS" : "fail"} reward=${record.reward}`,
			);
		}),
	);
	if (pending.length) printTable(pending);
	process.exit(0);
}

// ----------------------------------------------------------------------------
// Running tasks.

const mode = flags.mode as "agent" | "oracle" | "nop";
if (!["agent", "oracle", "nop"].includes(mode))
	throw new Error("--mode accepts agent, oracle or nop.");
if (!flags.live)
	throw new Error(
		"Refusing to run: pass --live (dev VMs, and the Codex subscription in agent mode).",
	);
const variant = harnessVariantFromFlags(flags.variant);
const loopAttempts = attemptLimit(variant.attempts);
// Every arm gets the same agent budget: earlier attempts are staged only
// within the time left before the invocation's ceiling (else not graded).
const afterAgentReserveSec = AFTER_AGENT_RESERVE_SEC;
const tasks = selectedTasks();
const requestedAgentSeconds = Math.round(Number(flags["agent-minutes"]) * 60);
if (!(requestedAgentSeconds >= 60))
	throw new Error("--agent-minutes must be at least 1.");
const concurrency = Math.max(
	1,
	Math.min(SLOT_LIMITS.codex, Number(flags.concurrency) || tasks.length),
);
if (flags.reasoning && !/^[a-z]+$/.test(flags.reasoning))
	throw new Error("--reasoning expects an effort name such as medium or high.");
const model = flags.model as string;
if (!/^[a-z0-9._-]+$/.test(model)) throw new Error("Unexpected model id.");
await assertDevelopmentDatabase();

// Same development-edge wiring as the smoke suite (scripts/smoke/builder-harness.ts).
process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;

let stopping = false;
let usageLimitHit: string | null = null;
const live = new Set<() => Promise<void>>();
onEvalStop(() => {
	stopping = true;
});
// The invocation never outlives its ceiling: past it, live turns are
// cancelled and cleaned up; a minute later the process exits regardless.
const watchdog = setTimeout(
	() => {
		stopping = true;
		console.warn("Invocation ceiling reached; cancelling live runs.");
		void Promise.allSettled([...live].map((cancel) => cancel())).finally(() =>
			setTimeout(() => process.exit(3), 60_000).unref(),
		);
	},
	invocationDeadline - Date.now() + 20_000,
);
watchdog.unref();

const ENVIRONMENT_NOTE = (workdir: string) =>
	`\n\n(Environment: your shell commands run inside the task's container, starting in ${workdir}. File tools reach the task's working directory directly; use the shell for files elsewhere.)`;
const PROMPT_SUFFIX =
	"\n\nWork directly in this environment: no plan proposal, child tasks, commits, pull requests or publishing. Stop when the task is done and checked.";

async function runTask(
	task: HardSetTask,
	environment: TaskEnvironment,
	attempt: string,
): Promise<HardSetRecord> {
	const record: HardSetRecord = {
		...emptyRecord(`codex:${model}`, task.id),
		run: flags.run as string,
		attempt,
		category: task.category,
		mode,
		variant: harnessVariantLabel(variant),
		reasoning: flags.reasoning ?? null,
		startedAt: new Date().toISOString(),
		reward: null,
		passed: false,
		status: "error",
		setupSec: 0,
		agentSec: 0,
		agentBudgetSec: 0,
		agentRequestedSec: 0,
		stageSec: 0,
		gradeSec: 0,
		testsExit: null,
		testsTail: "",
		gradeError: null,
		usageLimit: null,
		vmResources: null,
		graderVmId: null,
		gradeStartedAt: null,
		gradeTimeoutSec: null,
	};
	const started = Date.now();
	const agentSeconds = Math.min(
		requestedAgentSeconds,
		(task.maxAgentMinutes ?? Number.POSITIVE_INFINITY) * 60,
	);
	if (mode === "agent") record.agentRequestedSec = agentSeconds;
	if (stopping) {
		record.state = "skipped";
		record.errors.push(usageLimitHit ?? "Run stopped before this task.");
		await saveRecord(runDir, record);
		return record;
	}
	let user: EvalUser | undefined;
	let sessionId: string | undefined;
	let agentVm: string | undefined;
	let graderVm: string | undefined;
	let keepGrader = false;
	const cancel = async () => {
		if (user && sessionId)
			await cancelServerTurn(user.userId, sessionId).catch(() => {});
	};
	live.add(cancel);
	try {
		user = await createEvalUser({
			label: `hard-set ${task.id} ${harnessVariantLabel(variant)}`,
			variant,
		});
		const session = await insertAgentSession({
			userId: user.userId,
			projectId: user.project.projectId,
			workspaceId: user.project.workspaceId,
			harness: "codex",
			title: `Hard set ${task.id}`,
			listedModelId: model,
		});
		sessionId = session.id;
		// The grader VM boots and pulls the verifier image while the agent works.
		const grader = createVm(
			`ytimesy-hardset-grader-${randomUUID().slice(0, 12)}`,
			"ytimesy-hard-set-grader",
			environment.verifierCpus,
			environment.verifierMemoryMb,
			GRADER_LIFETIME_SEC,
			(vmId) => {
				graderVm = vmId;
			},
		).then(async () => {
			await startDetached(
				graderVm as string,
				graderPullScript(environment),
				"pull",
			);
			return graderVm as string;
		});
		grader.catch(() => {});
		const owner = user;
		// Usage admission resolves the VM owner from this session-derived slug.
		record.vmResources = await createVm(
			`ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			"ytimesy-hard-set",
			environment.cpus,
			environment.memoryMb,
			Math.ceil((invocationDeadline - Date.now()) / 1000) + 120,
			(vmId) => {
				agentVm = vmId;
				void owner.trackVm(vmId);
			},
		);
		const vm = agentVm as string;
		await saveAgentSessionProviderRef(session.id, vm);
		for (const [path, content] of Object.entries(
			setupFiles(environment, user.project.dirName),
		))
			await machines.writeTextFile(WorkspaceId(vm), path, content);
		if (mode === "oracle")
			await uploadDirectory(
				vm,
				join(environment.dir, "solution"),
				"/tb/solution",
			);
		const setup = await runDetached(
			vm,
			"exec bash /tb/setup.sh\n",
			"setup-run",
			Math.min(
				300,
				Math.floor(
					(invocationDeadline - Date.now()) / 1000 - afterAgentReserveSec,
				),
			),
		);
		record.setupSec = seconds(started);
		console.info(
			`${task.id}: setup ${setup.exit === 0 ? "ok" : `FAILED (${setup.exit})`} in ${record.setupSec}s`,
		);
		if (setup.exit !== 0)
			throw new Error(`Environment setup failed: ${setup.log.slice(-1200)}`);
		const workdir = (await execOk(vm, "cat /tb/workdir", 15_000)).trim();
		const agentStarted = Date.now();
		const agentDeadline = Math.min(
			agentStarted + agentSeconds * 1000,
			invocationDeadline - afterAgentReserveSec * 1000,
		);
		record.agentBudgetSec = Math.max(
			0,
			Math.round((agentDeadline - agentStarted) / 1000),
		);
		if (mode === "oracle") {
			const oracle = await runDetached(
				vm,
				oracleScript(
					environment,
					Math.max(30, (agentDeadline - Date.now()) / 1000),
				),
				"oracle",
				Math.max(60, (agentDeadline - Date.now()) / 1000 + 30),
			);
			record.state = /ORACLE_EXIT=0/.test(oracle.log)
				? "completed"
				: "oracle-failed";
			if (record.state !== "completed")
				record.errors.push(safe(oracle.log.slice(-600)));
		} else if (mode === "agent") {
			if (record.agentBudgetSec < 60)
				throw new Error("Setup left no time for the agent.");
			await database().query(
				"update agent_session set status='ready' where id=$1",
				[session.id],
			);
			// The loop (attempts, or a review's check and fix) finishes before the cancel.
			if (loopAttempts > 1 || variant.review === "on")
				await saveAttemptLoopDeadline(session.id, agentDeadline - 20_000);
			const text = `${environment.instruction}${ENVIRONMENT_NOTE(workdir)}${PROMPT_SUFFIX}`;
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
								{ modelId: model, text, variant: flags.reasoning },
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
								? `agent time limit (${record.agentBudgetSec}s)`
								: stopping
									? "run stopped"
									: null;
						if (reason && !cancelSent) {
							cancelSent = true;
							record.errors.push(`Cancelled: ${reason}.`);
							await cancelServerTurn(owner.userId, session.id);
						}
						if (Date.now() > agentDeadline + 45_000) {
							record.state = "unsettled";
							break;
						}
						await delay(3000);
					}
					if (flags.transcripts) {
						const state = await turnState(session.id);
						await writeFile(
							join(runDir, `${task.id}.${attempt}.transcript.json`),
							JSON.stringify(
								{ items: state?.items, messages: state?.messages },
								null,
								1,
							),
						).catch((error) =>
							console.warn("Transcript was not written:", safe(error)),
						);
					}
				},
				() => stopping,
			);
			record.completed = record.state === "completed";
		} else {
			record.state = "nop";
		}
		record.agentSec = seconds(agentStarted);
		if (record.usageLimit) throw new Error(record.usageLimit);
		// Stage: collect and copy the artifacts out of the task environment.
		const stageStarted = Date.now();
		await cancel();
		const staged = await runDetached(
			vm,
			stageScript(environment),
			"stage",
			120,
		);
		if (staged.exit !== 0)
			throw new Error(`Staging failed: ${staged.log.slice(-600)}`);
		const artifacts = await client.vms.ref(vm).fs.readFile("/tb/artifacts.tgz");
		// The attempt loop: every earlier candidate is staged too, so the
		// grader judges each attempt and the checker's verdicts can be scored.
		const attemptArtifacts = new Map<string, Uint8Array>();
		// Stages one earlier tree for its own grade (the VM is deleted after).
		const stageTree = async (
			entry: {
				n: number;
				gradeName: string | null;
				snapshot: AttemptSnapshot;
				graderReward: number | null;
				graderPassed: boolean | null;
			},
			branch: string,
			notes: string[],
			label: string,
		) => {
			if (!entry.gradeName || attemptArtifacts.has(entry.gradeName)) return;
			if (Date.now() > invocationDeadline - 45_000) {
				notes.push(
					`${label} ${entry.n} was not staged: no time left in the invocation.`,
				);
				entry.gradeName = null;
				return;
			}
			try {
				const restored = await machines.exec(
					WorkspaceId(vm),
					restoreSnapshotCommand(entry.snapshot, branch),
					60_000,
				);
				if (restored.exitCode !== 0)
					throw new Error(restored.stderr.slice(-300));
				const stagedTree = await runDetached(
					vm,
					stageScript(environment, entry.gradeName),
					`stage-${entry.gradeName}`,
					90,
				);
				if (stagedTree.exit !== 0) throw new Error(stagedTree.log.slice(-300));
				attemptArtifacts.set(
					entry.gradeName,
					await client.vms.ref(vm).fs.readFile(`/tb/${entry.gradeName}.tgz`),
				);
			} catch (error) {
				notes.push(
					`${label} ${entry.n} was not staged: ${safe(error).slice(0, 200)}`,
				);
				entry.gradeName = null;
				entry.graderReward = null;
				entry.graderPassed = null;
			}
		};
		// The attempt loop: every earlier candidate is staged too, so the
		// grader judges each attempt and the checker's verdicts can be scored.
		if (mode === "agent" && loopAttempts > 1) {
			record.attemptLoop = await readAttemptLoop(session.id, vm);
			const loop = record.attemptLoop;
			for (const loopAttempt of loop?.attempts ?? [])
				await stageTree(
					loopAttempt,
					loop?.branch ?? "",
					loop?.notes ?? [],
					"Attempt",
				);
		}
		// The review loop: each checked tree that is not the final one is
		// graded too (did a fix turn a failing tree into a passing one?).
		if (mode === "agent" && loopAttempts === 1 && variant.review === "on") {
			record.reviewLoop = await readReviewLoop(session.id, vm);
			const loop = record.reviewLoop;
			for (const round of loop?.rounds ?? [])
				await stageTree(round, loop?.branch ?? "", loop?.notes ?? [], "Round");
		}
		record.stageSec = seconds(stageStarted);
		// Grade on the grader VM: the tests never reach the agent's VM.
		const graderId = await grader;
		await client.vms.ref(graderId).fs.writeFile("/tb/artifacts.tgz", artifacts);
		const hasTests = await machines.exec(
			WorkspaceId(graderId),
			`for _ in $(seq 240); do [ -f /tb/pull.exit ] && break; sleep 1; done; sudo docker run --rm --entrypoint test ${sh(environment.verifierImage)} -f /tests/test.sh`,
			280_000,
		);
		if (hasTests.exitCode !== 0)
			await uploadDirectory(
				graderId,
				join(environment.dir, "tests"),
				"/tb/tests",
			);
		record.graderVmId = graderId;
		record.gradeStartedAt = new Date().toISOString();
		record.gradeTimeoutSec = environment.verifierTimeoutSec;
		await startDetached(
			graderId,
			verifyScript(environment, environment.verifierTimeoutSec),
			"verify",
		);
		const gradedLoop = record.attemptLoop ?? record.reviewLoop;
		if (attemptArtifacts.size && gradedLoop) {
			for (const [name, archive] of attemptArtifacts)
				await client.vms.ref(graderId).fs.writeFile(`/tb/${name}.tgz`, archive);
			await startDetached(
				graderId,
				attemptsVerifyScript(environment, environment.verifierTimeoutSec, [
					...attemptArtifacts.keys(),
				]),
				"verify-attempts",
			);
			gradedLoop.attemptGrading = "grading";
		}
		record.status = "grading";
		keepGrader = true;
		await saveRecord(runDir, record);
	} catch (error) {
		record.errors.push(safe(error));
		record.status = "error";
	} finally {
		live.delete(cancel);
		if (user && sessionId)
			await cancelServerTurn(user.userId, sessionId).catch(() => {});
		if (agentVm) await client.vms.delete(agentVm).catch(() => {});
		if (user && sessionId)
			await deleteAgentSessionForOwner(user.userId, sessionId).catch(() => {});
		if (user) {
			const leaked = await user.release();
			if (leaked.length)
				record.errors.push(`Cleanup left: ${leaked.join(", ")}`);
		}
		if (!keepGrader && graderVm)
			await client.vms.delete(graderVm).catch(() => {});
		record.elapsedMs = record.agentSec * 1000;
	}
	// Wait for the tests while the invocation has time; --collect finishes the rest.
	if (record.status === "grading")
		await finishGrading(record, invocationDeadline - 15_000);
	await saveRecord(runDir, record);
	console.info(
		`${task.id}: ${record.status === "grading" ? "grading (collect later)" : record.passed ? "PASS" : "fail"} reward=${record.reward} state=${record.state} agent=${record.agentSec}s/${record.agentBudgetSec}s total=${seconds(started)}s${record.errors.length ? ` errors=${record.errors.join(" | ").slice(0, 300)}` : ""}`,
	);
	return record;
}

const environments = new Map<string, TaskEnvironment>();
for (const task of tasks) {
	const environment = await loadTaskEnvironment(
		flags.dataset as string,
		task.id,
	);
	if (environment.gpus > 0) throw new Error(`${task.id} needs a GPU.`);
	if (environment.mcpServers > 0)
		throw new Error(`${task.id} needs task MCP servers; unsupported.`);
	environments.set(task.id, environment);
}
if (mode === "agent") await preflightExecutor();
const ownerId = mode === "agent" ? await subscriptionOwner() : null;
const usageBefore = ownerId ? await codexUsage(ownerId) : null;
console.info(
	`Hard set run ${flags.run}: ${tasks.length} task(s), mode ${mode}, variant ${harnessVariantLabel(variant)}, model ${model}${flags.reasoning ? ` (${flags.reasoning})` : ""}, agent ${requestedAgentSeconds}s (less for large images), ceiling ${maxMinutes} min, concurrency ${concurrency}.${usageBefore ? ` Codex usage before: ${usageBefore}.` : ""}`,
);
if (usageBefore?.includes("LIMIT REACHED"))
	throw new Error("Codex usage limit already reached; not starting.");

const existing = await readRecords(runDir);
const attemptFor = (id: string) => {
	const used = existing.filter((record) => record.task === id).length;
	existing.push({ task: id } as HardSetRecord);
	return String(used + 1);
};
const records: HardSetRecord[] = [];
const queue = tasks.map((task) => ({ task, attempt: attemptFor(task.id) }));
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length) {
			const next = queue.shift() as (typeof queue)[number];
			records.push(
				await runTask(
					next.task,
					environments.get(next.task.id) as TaskEnvironment,
					next.attempt,
				),
			);
		}
	}),
);
clearTimeout(watchdog);
const usageAfter = ownerId ? await codexUsage(ownerId) : null;
await closeDatabase();
const order = new Map(tasks.map((task, index) => [task.id, index]));
records.sort((a, b) => (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0));
printTable(records);
const scored = records.filter(isScored);
const grading = records.filter((record) => record.status === "grading");
console.log(
	`\n${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed; ${grading.length} still grading${grading.length ? ` (then: --collect --run ${flags.run})` : ""}. Wall ${seconds(invocationStart)}s.${usageAfter ? ` Codex usage after: ${usageAfter}.` : ""}${usageLimitHit ? ` STOPPED on the Codex usage limit: ${usageLimitHit}` : ""}\nRecords: ${runDir}`,
);
const cost = costSummary(scored.filter((record) => record.mode === "agent"));
if (cost) console.log(cost);
for (const record of records.filter(
	(record) => record.errors.length || record.gradeError,
))
	console.log(
		`- ${record.task}: ${[...record.errors, record.gradeError].filter(Boolean).join(" | ").slice(0, 500)}`,
	);
process.exit(0);
