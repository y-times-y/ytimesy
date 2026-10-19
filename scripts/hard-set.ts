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
//
// Detached (agent budgets longer than one invocation, docs/hard-set.md):
// node --env-file=.env --import tsx scripts/hard-set.ts --live --detach --run <name> --tasks a,b --agent-minutes 30
// node --env-file=.env --import tsx scripts/hard-set.ts --status [--run <name>]
// node --env-file=.env --import tsx scripts/hard-set.ts --collect --run <name>   # repeat until done
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
import { modelRouteId } from "../src/domain/model-connection";
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
	saveTurnDeadline,
} from "../src/server/adapters/attempt-loop-store";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../src/server/adapters/database";
import { dispatchModelWorkflow } from "../src/server/adapters/model-workflow-dispatch";
import { sendApiWorkspaceTask } from "../src/server/services/api-workspace-session";
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
	COLLECT_WINDOW_MS,
	collectAction,
	type DetachedPlan,
	type DetachedState,
	detachedStatusRows,
	lockedByOther,
	newDetachedState,
	START_NEEDS_MS,
	worthWaiting,
} from "./hard-set/detached";
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
	DEFAULT_GEMINI_KEY_FILE,
	geminiConnectionModels,
	probeGeminiQuota,
	readGeminiKey,
} from "./hard-set/gemini";
import type { HardSetRecord as BaseHardSetRecord } from "./hard-set/records";
import {
	type HardSetReviewRecord,
	reviewLoopReport,
} from "./hard-set/review-report";
import {
	type HardSetRoute,
	hardSetRoute,
	quotaStop,
	recordPricing,
} from "./hard-set/route";
import { infraFailure, isScored } from "./hard-set/scoring";
import { HARD_SET, HARD_SET_CHUNKS, type HardSetTask } from "./hard-set/tasks";
import { codexUsage, preflightExecutor, sh, taskVms } from "./hard-set/vm";
import {
	assertDevelopmentDatabase,
	emptyRecord,
	measureRun,
	safe,
	table,
	turnState,
} from "./smoke/builder-harness";
import {
	createEvalUser,
	type EvalUser,
	onEvalStop,
	releaseDetachedSlot,
	releaseEvalUser,
	SLOT_LIMITS,
	subscriptionOwner,
	tryDetachedSlot,
	withSlot,
} from "./smoke/eval-user";

const DEFAULT_DATASET = resolve("../cloud/.ytimesy/tb4-dataset");
const RUNS = resolve(".ytimesy/hard-set");
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
		/** Start the turns and return; --collect finishes them (docs/hard-set.md). */
		detach: { type: "boolean", default: false },
		/** Detached runs: phase, agent time used vs budget, what is next. */
		status: { type: "boolean", default: false },
		/** Groups the chunks of one pass; results go to .ytimesy/hard-set/<run>/. */
		run: { type: "string" },
		tasks: { type: "string" },
		/** 1-based chunk number from HARD_SET_CHUNKS (comma-separated for several). */
		chunk: { type: "string" },
		/** agent (default), oracle (reference solution, expect 1) or nop (no agent, expect 0). */
		mode: { type: "string", default: "agent" },
		/** A Codex model id (subscription) or google/<model> (Gemini API key). */
		model: { type: "string", default: "gpt-6.1-sol" },
		/** The Gemini key file for google/<model> runs (never printed). */
		"google-key-file": { type: "string", default: DEFAULT_GEMINI_KEY_FILE },
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
		...recordPricing(record.model),
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

/** The shared record (scripts/hard-set/records.ts) plus this runner's loop and detached state. */
type HardSetRecord = BaseHardSetRecord & {
	/** attempts=3: the loop's attempts, checker verdicts and per-attempt grades. */
	attemptLoop?: HardSetLoopRecord | null;
	/** review=on: the review rounds, checker verdicts and the grade of each checked tree. */
	reviewLoop?: HardSetReviewRecord | null;
	/** --detach: what later --collect invocations need to start or finish it. */
	detached?: DetachedState | null;
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
				["grading", "queued", "running"].includes(record.status)
					? "..."
					: record.passed
						? "PASS"
						: "fail",
				record.reward === null ? "-" : String(record.reward),
				record.usageLimit
					? "usage-limit"
					: infraFailure(record)
						? "infra"
						: ["grading", "queued", "running"].includes(record.status)
							? record.status
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
	model: string,
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
		modelBilling(recordPricing(hardSetRoute(model).recordModel)),
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
	model: string,
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
		modelBilling(recordPricing(hardSetRoute(model).recordModel)),
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
		`\nRun ${flags.run}: ${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed (${byCategory("hard")}, ${byCategory("time-pressure")}, ${byCategory("control")}); ${records.length - scored.length} not scored (grading, skipped, infra or usage limit, short budget or no reward).`,
	);
	const retry = [
		...new Set(records.filter(infraFailure).map((record) => record.task)),
	].filter(
		(task) =>
			!scored.some((record) => record.task === task) &&
			!records.some(
				(record) => record.task === task && record.status === "grading",
			),
	);
	if (retry.length)
		console.log(
			`Infra failures (not the model's): retry with --tasks ${retry.join(",")} --run ${flags.run}`,
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

if (flags.status) {
	const runs = flags.run
		? [flags.run]
		: (await readdir(RUNS).catch(() => [] as string[])).sort();
	const records: HardSetRecord[] = [];
	for (const run of runs)
		records.push(
			...(await readRecords(join(RUNS, run))).filter(
				(record) =>
					record.detached &&
					(flags.run ||
						["queued", "running", "grading"].includes(record.status)),
			),
		);
	records.sort((a, b) =>
		`${a.run}/${a.task}.${a.attempt}`.localeCompare(
			`${b.run}/${b.task}.${b.attempt}`,
		),
	);
	if (!records.length)
		console.log(
			flags.run
				? `No detached runs in ${flags.run}.`
				: "No detached runs in progress (--status --run <name> shows finished ones too).",
		);
	else console.log(table(detachedStatusRows(records, Date.now())));
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

// ----------------------------------------------------------------------------
// One task's run, in steps shared by the attached run (one invocation does
// all of it) and the detached one (--detach starts it, --collect finishes it).

type RunOptions = {
	/** As passed: a Codex model id or google/<model>. */
	model: string;
	route: HardSetRoute;
	reasoning: string | null;
	variantFlags: string[];
	variant: ReturnType<typeof harnessVariantFromFlags>;
	loopAttempts: number;
	mode: "agent" | "oracle" | "nop";
	transcripts: boolean;
	/** The agent budget for this task (its maxAgentMinutes applied). */
	agentSeconds: number;
};

type TaskRun = {
	task: HardSetTask;
	environment: TaskEnvironment;
	record: HardSetRecord;
	options: RunOptions;
	detached: boolean;
	user: EvalUser | null;
	userId: string | null;
	sessionId: string | null;
	agentVm: string | null;
	graderVm: string | null;
	grader: Promise<string> | null;
	workdir: string;
	agentStarted: number;
	agentDeadline: number;
};

let stopping = false;
let usageLimitHit: string | null = null;
const live = new Set<() => Promise<void>>();

const ENVIRONMENT_NOTE = (workdir: string) =>
	`\n\n(Environment: your shell commands run inside the task's container, starting in ${workdir}. File tools reach the task's working directory directly; use the shell for files elsewhere.)`;
const PROMPT_SUFFIX =
	"\n\nWork directly in this environment: no plan proposal, child tasks, commits, pull requests or publishing. Stop when the task is done and checked.";
// Setup of the task's environment never takes longer than this.
const SETUP_LIMIT_SEC = 300;

function runOptions(input: {
	model: string;
	reasoning: string | null;
	variantFlags: string[];
	mode: string;
	transcripts: boolean;
	agentSeconds: number;
}): RunOptions {
	const route = hardSetRoute(input.model);
	if (input.reasoning && !/^[a-z]+$/.test(input.reasoning))
		throw new Error(
			"--reasoning expects an effort name such as medium or high.",
		);
	if (!["agent", "oracle", "nop"].includes(input.mode))
		throw new Error("--mode accepts agent, oracle or nop.");
	const variant = harnessVariantFromFlags(input.variantFlags);
	return {
		model: input.model,
		route,
		reasoning: input.reasoning,
		variantFlags: input.variantFlags,
		variant,
		loopAttempts: attemptLimit(variant.attempts),
		mode: input.mode as RunOptions["mode"],
		transcripts: input.transcripts,
		agentSeconds: input.agentSeconds,
	};
}

/**
 * A task's budget: the requested one, capped by its maxAgentMinutes when
 * setup and agent share one invocation (large images set up slowly). A
 * detached run's setup is outside the budget, so every task gets it whole.
 */
const taskAgentSeconds = (
	task: HardSetTask,
	requested: number,
	detached: boolean,
) =>
	detached
		? requested
		: Math.min(
				requested,
				(task.maxAgentMinutes ?? Number.POSITIVE_INFINITY) * 60,
			);

function newRecord(
	task: HardSetTask,
	attempt: string,
	options: RunOptions,
): HardSetRecord {
	return {
		...emptyRecord(options.route.recordModel, task.id),
		run: flags.run as string,
		attempt,
		category: task.category,
		mode: options.mode,
		variant: harnessVariantLabel(options.variant),
		reasoning: options.reasoning,
		startedAt: new Date().toISOString(),
		reward: null,
		passed: false,
		status: "error",
		setupSec: 0,
		agentSec: 0,
		agentBudgetSec: 0,
		agentRequestedSec: options.mode === "agent" ? options.agentSeconds : 0,
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
}

// Gemini's free tier is per project and model (5 requests/min measured on
// 2026-10-18), so Gemini runs share the `gemini` slots (default 1).
const slotName = (route: HardSetRoute) =>
	route.kind === "google" ? "gemini" : "codex";
const slotLimit = (route: HardSetRoute) =>
	route.kind === "google" ? SLOT_LIMITS.gemini : SLOT_LIMITS.codex;

/** The session's model id: the Codex id, or the eval user's Gemini connection route. */
const listedModelId = (route: HardSetRoute, user: EvalUser) =>
	route.kind === "google"
		? modelRouteId(user.googleConnectionId as string, route.modelId)
		: route.modelId;

const googleSetups = new Map<
	string,
	Promise<{
		apiKey: string;
		models: Awaited<ReturnType<typeof geminiConnectionModels>>;
	}>
>();
/**
 * A Gemini run: the key's catalog entry for the model, and one probe request
 * so a spent quota stops the run before any VM starts (once per invocation).
 */
function ensureGoogle(modelId: string) {
	let setup = googleSetups.get(modelId);
	if (!setup) {
		setup = (async () => {
			const apiKey = await readGeminiKey(flags["google-key-file"]);
			const models = await geminiConnectionModels(apiKey, modelId);
			const quota = await probeGeminiQuota(apiKey, modelId);
			if (quota.state === "limited") {
				console.log(
					`GEMINI_QUOTA ${JSON.stringify({ daily: quota.daily, retryAfterSec: quota.retryAfterSec, quotaIds: quota.quotaIds })}`,
				);
				throw new Error(
					`Gemini quota reached (${quota.quotaIds.join(", ") || "429"}${quota.retryAfterSec ? `, retry in ${quota.retryAfterSec}s` : ""}); not starting.`,
				);
			}
			if (quota.state === "error")
				throw new Error(`Gemini probe failed (HTTP ${quota.status}).`);
			return { apiKey, models };
		})();
		googleSetups.set(modelId, setup);
	}
	return setup;
}

/** The grader VM: boots and pulls the verifier image (while the agent works, when attached). */
function startGrader(run: TaskRun) {
	const { environment } = run;
	const grader = createVm(
		`ytimesy-hardset-grader-${randomUUID().slice(0, 12)}`,
		"ytimesy-hard-set-grader",
		environment.verifierCpus,
		environment.verifierMemoryMb,
		GRADER_LIFETIME_SEC,
		(vmId) => {
			run.graderVm = vmId;
			if (run.record.detached) run.record.detached.graderVm = vmId;
		},
	).then(async () => {
		await startDetached(
			run.graderVm as string,
			graderPullScript(environment),
			"pull",
		);
		return run.graderVm as string;
	});
	grader.catch(() => {});
	run.grader = grader;
}

/** Eval user, session, agent VM and the task's environment on it. */
async function provision(run: TaskRun) {
	const { task, environment, record, options } = run;
	const started = Date.now();
	const google =
		options.route.kind === "google"
			? await ensureGoogle(options.route.modelId)
			: null;
	const user = await createEvalUser({
		label: `hard-set ${task.id} ${harnessVariantLabel(options.variant)}`,
		variant: options.variant,
		...(google ? { google } : {}),
	});
	run.user = user;
	run.userId = user.userId;
	const session = await insertAgentSession({
		userId: user.userId,
		projectId: user.project.projectId,
		workspaceId: user.project.workspaceId,
		harness: options.route.kind === "google" ? "api" : "codex",
		title: `Hard set ${task.id}`,
		listedModelId: listedModelId(options.route, user),
	});
	run.sessionId = session.id;
	if (run.record.detached) {
		run.record.detached.userId = user.userId;
		run.record.detached.sessionId = session.id;
	}
	if (!run.detached) startGrader(run);
	// A detached task's VM outlives this invocation: setup, the agent's
	// budget, then the window in which a --collect finishes it.
	const lifetimeSec = run.detached
		? SETUP_LIMIT_SEC + options.agentSeconds + COLLECT_WINDOW_MS / 1000 + 120
		: Math.ceil((invocationDeadline - Date.now()) / 1000) + 120;
	// Usage admission resolves the VM owner from this session-derived slug.
	record.vmResources = await createVm(
		`ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
		"ytimesy-hard-set",
		environment.cpus,
		environment.memoryMb,
		lifetimeSec,
		(vmId) => {
			run.agentVm = vmId;
			void user.trackVm(vmId);
			if (run.record.detached) {
				run.record.detached.agentVm = vmId;
				run.record.detached.vmExpiresAt = Date.now() + lifetimeSec * 1000;
			}
		},
	);
	const vm = run.agentVm as string;
	await saveAgentSessionProviderRef(session.id, vm);
	for (const [path, content] of Object.entries(
		setupFiles(environment, user.project.dirName),
	))
		await machines.writeTextFile(WorkspaceId(vm), path, content);
	if (options.mode === "oracle")
		await uploadDirectory(
			vm,
			join(environment.dir, "solution"),
			"/tb/solution",
		);
	const setup = await runDetached(
		vm,
		"exec bash /tb/setup.sh\n",
		"setup-run",
		run.detached
			? SETUP_LIMIT_SEC
			: Math.min(
					SETUP_LIMIT_SEC,
					Math.floor(
						(invocationDeadline - Date.now()) / 1000 - AFTER_AGENT_RESERVE_SEC,
					),
				),
	);
	record.setupSec = seconds(started);
	console.info(
		`${task.id}: setup ${setup.exit === 0 ? "ok" : `FAILED (${setup.exit})`} in ${record.setupSec}s`,
	);
	if (setup.exit !== 0)
		throw new Error(`Environment setup failed: ${setup.log.slice(-1200)}`);
	run.workdir = (await execOk(vm, "cat /tb/workdir", 15_000)).trim();
	run.agentStarted = Date.now();
	// Attached, the agent's time ends before the invocation's ceiling; detached,
	// it gets its full budget (the edge cancels the turn at the deadline).
	run.agentDeadline = run.detached
		? run.agentStarted + options.agentSeconds * 1000
		: Math.min(
				run.agentStarted + options.agentSeconds * 1000,
				invocationDeadline - AFTER_AGENT_RESERVE_SEC * 1000,
			);
	record.agentBudgetSec = Math.max(
		0,
		Math.round((run.agentDeadline - run.agentStarted) / 1000),
	);
	if (run.record.detached) {
		run.record.detached.workdir = run.workdir;
		run.record.detached.agentStartedAt = run.agentStarted;
		run.record.detached.agentDeadlineAt = run.agentDeadline;
	}
}

/** Sends the task as a chat and has the edge admit its turn. */
async function startTurn(run: TaskRun) {
	const { environment, options } = run;
	const sessionId = run.sessionId as string;
	const user = run.user as EvalUser;
	if (run.record.agentBudgetSec < 60)
		throw new Error("Setup left no time for the agent.");
	await database().query(
		"update agent_session set status='ready' where id=$1",
		[sessionId],
	);
	// The loop (attempts, or a review's check and fix) finishes before the cancel.
	if (options.loopAttempts > 1 || options.variant.review === "on")
		await saveAttemptLoopDeadline(sessionId, run.agentDeadline - 20_000);
	// The edge cancels the turn at the deadline, with or without this runner.
	await saveTurnDeadline(sessionId, run.agentDeadline);
	const text = `${environment.instruction}${ENVIRONMENT_NOTE(run.workdir)}${PROMPT_SUFFIX}`;
	const scope = {
		userId: user.userId,
		projectId: user.project.projectId,
		sessionId,
	};
	await withBackgroundJobDispatcher(
		async () => {},
		() =>
			options.route.kind === "google"
				? sendApiWorkspaceTask(scope, {
						modelId: listedModelId(options.route, user),
						text,
					})
				: sendSubscriptionTask(scope, {
						modelId: options.route.modelId,
						text,
						variant: options.reasoning ?? undefined,
					}),
	);
	const admitStarted = Date.now();
	while (Date.now() < admitStarted + 120_000 && !stopping) {
		const turn = await claimApiTurn(
			Math.min(64, SLOT_LIMITS.codex),
			64,
			"durable-object",
			sessionId,
		);
		if (turn?.lease_id) {
			await dispatchModelWorkflow(turn);
			return;
		}
		const state = await turnState(sessionId);
		if (state && state.state !== "queued") return;
		await delay(2000);
	}
	throw new Error("Turn was not admitted within two minutes.");
}

/** Reads the turn once into the record; flags a usage limit or provider quota. */
async function pollTurn(run: { record: HardSetRecord; sessionId: string }) {
	const state = await turnState(run.sessionId);
	const items = sessionItemsFromUnknown(state?.items);
	measureRun(run.record, items, state?.messages, () => 0);
	run.record.state = state?.state ?? "missing";
	const quota = quotaStop(
		run.record.model.startsWith("google/") ? "google" : "codex",
		JSON.stringify(items.filter((item) => item.kind === "error")),
	);
	if (quota) {
		run.record.usageLimit = quota;
		usageLimitHit = quota;
		stopping = true;
	}
	return run.record.state;
}

const turnLive = (state: string) => ["queued", "running"].includes(state);

/** Attached: polls the turn and cancels it at the deadline. */
async function watchTurn(run: TaskRun) {
	const user = run.user as EvalUser;
	const sessionId = run.sessionId as string;
	let cancelSent = false;
	while (true) {
		const state = await pollTurn({ record: run.record, sessionId });
		if (!turnLive(state)) break;
		const reason =
			Date.now() > run.agentDeadline
				? `agent time limit (${run.record.agentBudgetSec}s)`
				: stopping
					? "run stopped"
					: null;
		if (reason && !cancelSent) {
			cancelSent = true;
			run.record.errors.push(`Cancelled: ${reason}.`);
			await cancelServerTurn(user.userId, sessionId);
		}
		if (Date.now() > run.agentDeadline + 45_000) {
			run.record.state = "unsettled";
			break;
		}
		await delay(3000);
	}
}

async function saveTranscript(run: TaskRun) {
	if (!run.options.transcripts || !run.sessionId) return;
	const state = await turnState(run.sessionId);
	await writeFile(
		join(runDir, `${run.task.id}.${run.record.attempt}.transcript.json`),
		JSON.stringify({ items: state?.items, messages: state?.messages }, null, 1),
	).catch((error) => console.warn("Transcript was not written:", safe(error)));
}

/**
 * Stages the result (and every earlier tree of the loop), hands it to the
 * grader VM and starts the tests; the record says grading after this.
 */
async function stageAndGrade(run: TaskRun) {
	const { environment, record, options } = run;
	const vm = run.agentVm as string;
	const sessionId = run.sessionId as string;
	const stageStarted = Date.now();
	if (run.userId) await cancelServerTurn(run.userId, sessionId).catch(() => {});
	const staged = await runDetached(vm, stageScript(environment), "stage", 120);
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
			if (restored.exitCode !== 0) throw new Error(restored.stderr.slice(-300));
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
	if (options.mode === "agent" && options.loopAttempts > 1) {
		record.attemptLoop = await readAttemptLoop(sessionId, vm, options.model);
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
	if (
		options.mode === "agent" &&
		options.loopAttempts === 1 &&
		options.variant.review === "on"
	) {
		record.reviewLoop = await readReviewLoop(sessionId, vm, options.model);
		const loop = record.reviewLoop;
		for (const round of loop?.rounds ?? [])
			await stageTree(round, loop?.branch ?? "", loop?.notes ?? [], "Round");
	}
	record.stageSec = seconds(stageStarted);
	// Grade on the grader VM: the tests never reach the agent's VM.
	if (!run.grader) throw new Error("No grader VM was started.");
	const graderId = await run.grader;
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
}

/** Deletes the run's session, agent VM and eval user (and the grader unless it grades). */
async function cleanupRun(run: TaskRun, keepGrader: boolean) {
	const { record } = run;
	if (run.userId && run.sessionId)
		await cancelServerTurn(run.userId, run.sessionId).catch(() => {});
	if (run.agentVm) await client.vms.delete(run.agentVm).catch(() => {});
	if (run.userId && run.sessionId)
		await deleteAgentSessionForOwner(run.userId, run.sessionId).catch(() => {});
	if (run.userId) {
		const leaked = run.user
			? await run.user.release()
			: await releaseEvalUser(run.userId).catch((error) => [safe(error)]);
		if (leaked.length) record.errors.push(`Cleanup left: ${leaked.join(", ")}`);
	}
	if (!keepGrader && run.graderVm)
		await client.vms.delete(run.graderVm).catch(() => {});
	if (record.detached?.slot) {
		await releaseDetachedSlot(record.detached.slot).catch(() => {});
		record.detached.slot = null;
	}
}

function logResult(run: TaskRun, started: number) {
	const { record } = run;
	console.info(
		`${run.task.id}.${record.attempt}: ${record.status === "grading" ? "grading (collect later)" : record.passed ? "PASS" : record.status === "running" ? "running on the edge" : record.status === "queued" ? "queued for a model slot" : "fail"} reward=${record.reward} state=${record.state} agent=${record.agentSec}s/${record.agentBudgetSec}s total=${seconds(started)}s${record.errors.length ? ` errors=${record.errors.join(" | ").slice(0, 300)}` : ""}`,
	);
}

function newRun(
	task: HardSetTask,
	environment: TaskEnvironment,
	record: HardSetRecord,
	options: RunOptions,
	detached: boolean,
): TaskRun {
	return {
		task,
		environment,
		record,
		options,
		detached,
		user: null,
		userId: null,
		sessionId: null,
		agentVm: null,
		graderVm: null,
		grader: null,
		workdir: "",
		agentStarted: 0,
		agentDeadline: 0,
	};
}

/** Attached: setup, agent, staging and grading in this invocation. */
async function runTask(
	task: HardSetTask,
	environment: TaskEnvironment,
	attempt: string,
	options: RunOptions,
): Promise<HardSetRecord> {
	const record = newRecord(task, attempt, options);
	const run = newRun(task, environment, record, options, false);
	const started = Date.now();
	if (stopping) {
		record.state = "skipped";
		record.errors.push(usageLimitHit ?? "Run stopped before this task.");
		await saveRecord(runDir, record);
		return record;
	}
	let keepGrader = false;
	const cancel = async () => {
		if (run.userId && run.sessionId)
			await cancelServerTurn(run.userId, run.sessionId).catch(() => {});
	};
	live.add(cancel);
	try {
		await provision(run);
		if (options.mode === "oracle") {
			const vm = run.agentVm as string;
			const oracle = await runDetached(
				vm,
				oracleScript(
					environment,
					Math.max(30, (run.agentDeadline - Date.now()) / 1000),
				),
				"oracle",
				Math.max(60, (run.agentDeadline - Date.now()) / 1000 + 30),
			);
			record.state = /ORACLE_EXIT=0/.test(oracle.log)
				? "completed"
				: "oracle-failed";
			if (record.state !== "completed")
				record.errors.push(safe(oracle.log.slice(-600)));
		} else if (options.mode === "agent") {
			await withSlot(
				slotName(options.route),
				slotLimit(options.route),
				async () => {
					await startTurn(run);
					await watchTurn(run);
					await saveTranscript(run);
				},
				() => stopping,
			);
			record.completed = record.state === "completed";
		} else {
			record.state = "nop";
		}
		record.agentSec = seconds(run.agentStarted);
		if (record.usageLimit) throw new Error(record.usageLimit);
		await stageAndGrade(run);
		keepGrader = true;
		await saveRecord(runDir, record);
	} catch (error) {
		record.errors.push(safe(error));
		record.status = "error";
	} finally {
		live.delete(cancel);
		await cleanupRun(run, keepGrader);
		record.elapsedMs = record.agentSec * 1000;
	}
	// Wait for the tests while the invocation has time; --collect finishes the rest.
	if (record.status === "grading")
		await finishGrading(record, invocationDeadline - 15_000);
	await saveRecord(runDir, record);
	logResult(run, started);
	return record;
}

const LOCK_OWNER = `${process.pid}:${randomUUID()}`;

/**
 * Marks a detached task as this invocation's to start or finalize (until its
 * ceiling plus the exit grace); false when another invocation holds it.
 */
async function lockDetached(record: HardSetRecord) {
	const state = record.detached as DetachedState;
	const onDisk = await readFile(
		join(runDir, `${record.task}.${record.attempt}.json`),
		"utf8",
	)
		.then((text) => (JSON.parse(text) as HardSetRecord).detached ?? null)
		.catch(() => null);
	if (onDisk && lockedByOther(onDisk, LOCK_OWNER, Date.now())) return false;
	state.lockedUntil = invocationDeadline + 90_000;
	state.lockOwner = LOCK_OWNER;
	await saveRecord(runDir, record);
	return true;
}

const unlockDetached = (state: DetachedState) => {
	state.lockedUntil = null;
	state.lockOwner = null;
};

/**
 * Detached: takes a Codex slot (or leaves the task queued), sets the task
 * up and starts its turn with the full budget, then hands everything to the
 * record: the turn runs on the edge, which cancels it at the deadline.
 */
async function startDetachedTask(
	task: HardSetTask,
	environment: TaskEnvironment,
	record: HardSetRecord,
	options: RunOptions,
) {
	const state = record.detached as DetachedState;
	const run = newRun(task, environment, record, options, true);
	const started = Date.now();
	if (stopping || invocationDeadline - Date.now() < START_NEEDS_MS) {
		record.status = "queued";
		await saveRecord(runDir, record);
		logResult(run, started);
		return record;
	}
	if (!(await lockDetached(record))) return record;
	state.slot = await tryDetachedSlot(
		slotName(options.route),
		slotLimit(options.route),
		`${record.run}/${task.id}.${record.attempt}`,
		// Upper bound: setup, the budget, settling.
		Date.now() + (SETUP_LIMIT_SEC + options.agentSeconds + 300) * 1000,
	);
	if (!state.slot) {
		record.status = "queued";
		unlockDetached(state);
		await saveRecord(runDir, record);
		logResult(run, started);
		return record;
	}
	const cancel = async () => {
		if (run.userId && run.sessionId)
			await cancelServerTurn(run.userId, run.sessionId).catch(() => {});
	};
	live.add(cancel);
	record.status = "running";
	record.startedAt = new Date().toISOString();
	await saveRecord(runDir, record);
	try {
		await provision(run);
		await saveRecord(runDir, record);
		await startTurn(run);
		state.phase = "running";
		state.turnState = await pollTurn({
			record,
			sessionId: run.sessionId as string,
		});
		// From here the user outlives this process; --collect releases it.
		await run.user?.detach((state.vmExpiresAt ?? Date.now()) + 10 * 60_000);
		live.delete(cancel);
		unlockDetached(state);
		await saveRecord(runDir, record);
	} catch (error) {
		live.delete(cancel);
		record.errors.push(safe(error));
		record.status = "error";
		await cleanupRun(run, false);
		unlockDetached(state);
		await saveRecord(runDir, record);
	}
	logResult(run, started);
	return record;
}

/** The settle time of the session's latest turn (epoch ms). */
async function turnSettledAt(sessionId: string) {
	const row = (
		await database().query<{ at: number }>(
			"select extract(epoch from updated_at)*1000 as at from api_turn where session_id=$1 order by created_at desc limit 1",
			[sessionId],
		)
	).rows[0];
	return row ? Number(row.at) : null;
}

/** Collect: stages and grades a detached task whose turn ended (or ran out). */
async function finalizeDetached(
	task: HardSetTask,
	environment: TaskEnvironment,
	record: HardSetRecord,
	options: RunOptions,
	unsettled: boolean,
) {
	const state = record.detached as DetachedState;
	const run = newRun(task, environment, record, options, true);
	run.userId = state.userId;
	run.sessionId = state.sessionId;
	run.agentVm = state.agentVm;
	run.workdir = state.workdir ?? "";
	run.agentStarted = state.agentStartedAt ?? 0;
	run.agentDeadline = state.agentDeadlineAt ?? 0;
	if (!(await lockDetached(record))) return;
	// A finalize an earlier invocation did not finish left this grader.
	if (state.graderVm) {
		await client.vms.delete(state.graderVm).catch(() => {});
		state.graderVm = null;
	}
	state.phase = "finalizing";
	state.finalizeStartedAt = Date.now();
	await saveRecord(runDir, record);
	let keepGrader = false;
	try {
		if (!run.sessionId || !run.agentVm)
			throw new Error("The detached task never started its turn.");
		if (unsettled) {
			record.state = "unsettled";
			await cancelServerTurn(run.userId as string, run.sessionId).catch(
				() => {},
			);
		}
		const settledAt = unsettled ? null : await turnSettledAt(run.sessionId);
		record.agentSec = Math.max(
			0,
			Math.round(
				((settledAt ?? Math.min(Date.now(), run.agentDeadline + 45_000)) -
					run.agentStarted) /
					1000,
			),
		);
		record.completed = record.state === "completed";
		if (state.slot) {
			await releaseDetachedSlot(state.slot).catch(() => {});
			state.slot = null;
		}
		await saveTranscript(run);
		if (record.usageLimit) throw new Error(record.usageLimit);
		startGrader(run);
		await stageAndGrade(run);
		keepGrader = true;
	} catch (error) {
		record.errors.push(safe(error));
		record.status = "error";
	} finally {
		await cleanupRun(run, keepGrader);
		record.elapsedMs = record.agentSec * 1000;
		unlockDetached(state);
	}
	await saveRecord(runDir, record);
	logResult(run, state.finalizeStartedAt ?? Date.now());
}

/** Collect: one detached task, step by step, while this invocation can help it. */
async function advanceDetached(record: HardSetRecord) {
	const state = record.detached as DetachedState;
	const task = HARD_SET.find((candidate) => candidate.id === record.task);
	if (!task) throw new Error(`${record.task} is no longer in the hard set.`);
	const environment = await loadTaskEnvironment(state.plan.dataset, task.id);
	const options = runOptions({ ...state.plan, mode: "agent" });
	// Another invocation is starting or finalizing it right now.
	if (lockedByOther(state, LOCK_OWNER, Date.now())) {
		console.info(
			`${record.task}.${record.attempt}: another invocation holds it until ${new Date(state.lockedUntil as number).toISOString()}.`,
		);
		return;
	}
	// A start that an earlier invocation did not finish (its process was
	// stopped mid-setup): remove what it made and start over.
	if (state.phase === "queued" && (state.userId || state.slot)) {
		const run = newRun(task, environment, record, options, true);
		run.userId = state.userId;
		run.sessionId = state.sessionId;
		run.agentVm = state.agentVm;
		await cleanupRun(run, false);
		Object.assign(state, newDetachedState(state.plan));
		record.status = "queued";
		await saveRecord(runDir, record);
	}
	if (state.phase === "running" && !state.sessionId)
		throw new Error("Detached task is running without a session.");
	while (!["final", "grading", "error"].includes(record.status)) {
		const turn =
			state.phase === "running" && state.sessionId
				? await pollTurn({ record, sessionId: state.sessionId })
				: null;
		if (turn !== null) state.turnState = turn;
		const action = collectAction(state, {
			now: Date.now(),
			invocationEndsAt: invocationDeadline,
			turnState: turn,
			stopping,
			usageLimit: !!usageLimitHit,
		});
		if (action.kind === "start") {
			await ensureAgentPreflight(options.route);
			await startDetachedTask(task, environment, record, options);
			return;
		}
		if (action.kind === "expire") {
			record.errors.push(action.reason);
			record.status = "error";
			const run = newRun(task, environment, record, options, true);
			run.userId = state.userId;
			run.sessionId = state.sessionId;
			run.agentVm = state.agentVm;
			run.graderVm = state.graderVm;
			await cleanupRun(run, false);
			await saveRecord(runDir, record);
			return;
		}
		if (action.kind === "cancel") {
			state.cancelSentAt = Date.now();
			record.errors.push(
				`Cancelled: ${action.reason === "agent time limit" ? `agent time limit (${record.agentBudgetSec}s)` : action.reason}.`,
			);
			await cancelServerTurn(
				state.userId as string,
				state.sessionId as string,
			).catch(() => {});
		}
		if (action.kind === "finalize") {
			await finalizeDetached(
				task,
				environment,
				record,
				options,
				action.unsettled,
			);
			return;
		}
		await saveRecord(runDir, record);
		if (
			action.kind === "wait" &&
			!worthWaiting(state, Date.now(), invocationDeadline)
		)
			return;
		await delay(15_000);
	}
}

// ----------------------------------------------------------------------------
// Invocation wiring.

let edgeWired = false;
/** Same development-edge wiring as the smoke suite (scripts/smoke/builder-harness.ts). */
async function wireDevelopmentEdge() {
	if (edgeWired) return;
	edgeWired = true;
	await assertDevelopmentDatabase();
	process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
	process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	).secret;
	onEvalStop(() => {
		stopping = true;
	});
	// The invocation never outlives its ceiling: past it, live turns are
	// cancelled and cleaned up; a minute later the process exits regardless.
	// (A detached task's turn is not live here once it is handed to the edge.)
	setTimeout(
		() => {
			stopping = true;
			console.warn("Invocation ceiling reached; cancelling live runs.");
			void Promise.allSettled([...live].map((cancel) => cancel())).finally(() =>
				setTimeout(() => process.exit(3), 60_000).unref(),
			);
		},
		invocationDeadline - Date.now() + 20_000,
	).unref();
}

let preflight: Promise<void> | null = null;
/**
 * The executor preflight and, for a Codex run, the usage check, once per
 * invocation (a Gemini run's quota probe happens in ensureGoogle).
 */
function ensureAgentPreflight(route: HardSetRoute) {
	preflight ??= (async () => {
		await preflightExecutor();
		if (route.kind !== "codex") return;
		const ownerId = await subscriptionOwner();
		const usage = await codexUsage(ownerId);
		console.info(`Codex usage: ${usage}.`);
		if (usage?.includes("LIMIT REACHED")) {
			usageLimitHit = "Codex usage limit already reached";
			stopping = true;
		}
	})();
	return preflight;
}

const activeDetached = (record: HardSetRecord) =>
	!!record.detached && ["queued", "running"].includes(record.status);

function printDetachedStatus(records: HardSetRecord[]) {
	const detached = records.filter((record) => record.detached);
	if (detached.length)
		console.log(`\n${table(detachedStatusRows(detached, Date.now()))}`);
}

if (flags.collect) {
	// Detached tasks first: start queued ones, cancel and finalize ended ones.
	const detached = (await readRecords(runDir)).filter(activeDetached);
	if (detached.length) {
		await wireDevelopmentEdge();
		console.info(`Advancing ${detached.length} detached task(s) in ${runDir}.`);
		await Promise.all(
			detached.map((record) =>
				advanceDetached(record).catch(async (error: unknown) => {
					record.errors.push(`Collect: ${safe(error)}`);
					await saveRecord(runDir, record);
					console.warn(
						`${record.task}.${record.attempt}: collect failed: ${safe(error)}`,
					);
				}),
			),
		);
	}
	// Then every grader still running for this run.
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
	const all = await readRecords(runDir);
	printDetachedStatus(all);
	const open = all.filter(
		(record) => activeDetached(record) || record.status === "grading",
	);
	console.log(
		open.length
			? `\n${open.length} task(s) not final yet: run --collect --run ${flags.run} again${all.some((record) => record.status === "running") ? " (the edge cancels each turn at its deadline either way)" : ""}.`
			: `\nAll tasks of ${flags.run} are final: --report --run ${flags.run}.`,
	);
	if (edgeWired) await closeDatabase();
	process.exit(0);
}

// ----------------------------------------------------------------------------
// Running tasks.

if (!flags.live)
	throw new Error(
		"Refusing to run: pass --live (dev VMs, and the Codex subscription in agent mode).",
	);
const tasks = selectedTasks();
const requestedAgentSeconds = Math.round(Number(flags["agent-minutes"]) * 60);
if (!(requestedAgentSeconds >= 60))
	throw new Error("--agent-minutes must be at least 1.");
const baseOptions = runOptions({
	model: flags.model as string,
	reasoning: flags.reasoning ?? null,
	variantFlags: flags.variant ?? [],
	mode: flags.mode as string,
	transcripts: flags.transcripts as boolean,
	agentSeconds: requestedAgentSeconds,
});
const mode = baseOptions.mode;
if (flags.detach && mode !== "agent")
	throw new Error(
		"--detach runs agent turns only (oracle and nop fit one invocation).",
	);
if (!flags.detach && requestedAgentSeconds > maxMinutes * 60)
	throw new Error(
		`--agent-minutes ${flags["agent-minutes"]} does not fit the ${maxMinutes}-minute invocation; add --detach.`,
	);
const concurrency = Math.max(
	1,
	Math.min(
		slotLimit(baseOptions.route),
		Number(flags.concurrency) || tasks.length,
	),
);
await wireDevelopmentEdge();

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
if (mode === "agent" && baseOptions.route.kind === "google")
	await ensureGoogle(baseOptions.route.modelId);
const ownerId =
	mode === "agent" && baseOptions.route.kind === "codex"
		? await subscriptionOwner()
		: null;
const usageBefore = ownerId ? await codexUsage(ownerId) : null;
console.info(
	`Hard set run ${flags.run}: ${tasks.length} task(s), mode ${mode}, variant ${harnessVariantLabel(baseOptions.variant)}, model ${baseOptions.model}${baseOptions.reasoning ? ` (${baseOptions.reasoning})` : ""}, agent ${requestedAgentSeconds}s (less for large images), ${flags.detach ? "detached (--collect finishes each task)" : `ceiling ${maxMinutes} min`}, concurrency ${concurrency}.${usageBefore ? ` Codex usage before: ${usageBefore}.` : ""}`,
);
if (usageBefore?.includes("LIMIT REACHED"))
	throw new Error("Codex usage limit already reached; not starting.");
preflight = Promise.resolve();

const existing = await readRecords(runDir);
const attemptFor = (id: string) => {
	const used = existing.filter((record) => record.task === id).length;
	existing.push({ task: id } as HardSetRecord);
	return String(used + 1);
};
const records: HardSetRecord[] = [];
const queue = tasks.map((task) => ({ task, attempt: attemptFor(task.id) }));
const optionsFor = (task: HardSetTask) => ({
	...baseOptions,
	agentSeconds: taskAgentSeconds(task, requestedAgentSeconds, !!flags.detach),
});

if (flags.detach) {
	// Every task is recorded as queued first, so a later collect can start
	// any this invocation does not (no Codex slot, no time, a crash).
	const planned = await Promise.all(
		queue.map(async ({ task, attempt }) => {
			const options = optionsFor(task);
			const plan: DetachedPlan = {
				dataset: resolve(flags.dataset as string),
				model: options.model,
				reasoning: options.reasoning,
				variantFlags: options.variantFlags,
				agentSeconds: options.agentSeconds,
				transcripts: options.transcripts,
			};
			const record = newRecord(task, attempt, options);
			record.status = "queued";
			record.detached = newDetachedState(plan);
			await saveRecord(runDir, record);
			return { task, record, options };
		}),
	);
	const startQueue = [...planned];
	await Promise.all(
		Array.from(
			{ length: Math.min(concurrency, startQueue.length) },
			async () => {
				while (startQueue.length) {
					const next = startQueue.shift() as (typeof startQueue)[number];
					records.push(
						await startDetachedTask(
							next.task,
							environments.get(next.task.id) as TaskEnvironment,
							next.record,
							next.options,
						),
					);
				}
			},
		),
	);
	await closeDatabase();
	printDetachedStatus(records);
	const running = records.filter((record) => record.status === "running");
	const queued = records.filter((record) => record.status === "queued");
	const deadlines = running
		.map((record) => record.detached?.agentDeadlineAt ?? 0)
		.filter(Boolean);
	console.log(
		`\n${running.length} turn(s) running on the edge, ${queued.length} queued for a model slot, ${records.length - running.length - queued.length} failed to start. Wall ${seconds(invocationStart)}s.${deadlines.length ? ` Last deadline ${new Date(Math.max(...deadlines)).toISOString()}.` : ""}\nNext: --status --run ${flags.run}; --collect --run ${flags.run} after the deadlines (repeat until every task is final; it also starts queued tasks).${usageLimitHit ? ` STOPPED on a usage limit: ${usageLimitHit}` : ""}\nRecords: ${runDir}`,
	);
	for (const record of records.filter((record) => record.status === "error"))
		console.log(
			`- ${record.task}.${record.attempt}: ${record.errors.join(" | ").slice(0, 500)}`,
		);
	process.exit(0);
}

await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length) {
			const next = queue.shift() as (typeof queue)[number];
			records.push(
				await runTask(
					next.task,
					environments.get(next.task.id) as TaskEnvironment,
					next.attempt,
					optionsFor(next.task),
				),
			);
		}
	}),
);
const usageAfter = ownerId ? await codexUsage(ownerId) : null;
await closeDatabase();
const order = new Map(tasks.map((task, index) => [task.id, index]));
records.sort((a, b) => (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0));
printTable(records);
const scored = records.filter(isScored);
const grading = records.filter((record) => record.status === "grading");
console.log(
	`\n${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed; ${grading.length} still grading${grading.length ? ` (then: --collect --run ${flags.run})` : ""}. Wall ${seconds(invocationStart)}s.${usageAfter ? ` Codex usage after: ${usageAfter}.` : ""}${usageLimitHit ? ` STOPPED on a usage limit: ${usageLimitHit}` : ""}\nRecords: ${runDir}`,
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
