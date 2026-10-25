import type { ApiTokenUsage } from "#/domain/api-token-usage";
import {
	type AttemptSnapshot,
	type AttemptSpend,
	attemptDirectory,
	NO_ATTEMPT_SPEND,
	usageSince,
} from "#/domain/attempt-loop";
import { REVIEW_CHECK_TOOL } from "#/domain/check-summary";
import {
	CHECKER_FORCED_FINAL_MARK,
	checkerFindingsPath,
	findingsFileVerdict,
	type HarnessRun,
	independentReviewBrief,
	parseReviewVerdict,
	type ReviewVerdict,
	type VerdictVia,
} from "#/domain/checker-brief";
import {
	defaultPassVerdict,
	executedCommands,
	groundReviewVerdict,
	harnessCommands,
	harnessGrounded,
} from "#/domain/checker-evidence";
import { pairReviewVerdict, ranCommandsText } from "#/domain/checker-pair";
import { SessionItemId } from "#/domain/ids";
import { type ModelBilling, usageCostUsd } from "#/domain/model-pricing";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	countedChecks,
	decideAfterVerdict,
	decideCheck,
	expectedCheckMs,
	failingTests,
	findingResponses,
	maxReviewRounds,
	REVIEW_LOOP_LIMITS,
	type ReviewLoopState,
	type ReviewOutcome,
	type ReviewRound,
	type ReviewWorker,
	retryCheck,
	reviewEligibility,
	reviewFindings,
	reviewLoopSummary,
	reviewNotice,
} from "#/domain/review-loop";
import {
	admittedUnfinished,
	admittedUnverified,
	builderRequirements,
	UNVERIFIED_SEND_BACK_TIME_LEFT,
} from "#/domain/rigor";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import { sessionTokenUsage } from "#/domain/subagent-usage";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	type AttemptLoopDeps,
	type AttemptLoopOutcome,
	attemptReport,
	checkerDirectoryCommand,
	childBilling,
	loopChildModel,
	type ShellResult,
	turnUsage,
} from "./attempt-loop";

/**
 * The review loop's runtime (harness variant review=on; rules in
 * src/domain/review-loop.ts). It runs inside the root builder's durable
 * turn, with the attempt loop's plumbing (runtime-started read-only checker
 * subagent, report taken out of the builder's inbox, state per turn):
 *
 * 1. Checkpoint: before the first model step the working tree is captured
 *    (the diff's base) and the loop's deadline is set.
 * 2. Check: when the builder declares the turn complete and the turn is
 *    eligible (changed files; long enough or runnable) and the expected
 *    check plus a minimal fix still fit, the tree is captured and a checker
 *    gets the shared brief: the request verbatim, the changed files and the
 *    diff command.
 * 3. Decide: the verdict is pass or fail, never unsure. A checker cut off
 *    at its limit gets a tool-less final step (its runtime's step guard),
 *    else its findings file is the verdict; a pass nothing it ran shows is
 *    grounded by running its tests here; still nothing: one retry, then pass
 *    with a note. Pass finishes. Fail with concrete findings and time left
 *    adds one runtime notice with the findings to the same run and the
 *    builder continues; nothing is reset. Anything else finishes. With
 *    rigor=on, a final answer that admitted unverified work while over half
 *    the time was left is a finding too, and is sent back even after a pass.
 *
 * Waiting for the checker spans durable steps like the attempt loop.
 */

export type ReviewLoopDeps = Omit<
	AttemptLoopDeps,
	"load" | "save" | "routed" | "stopOwnedCommands"
> & {
	readonly load: (
		sessionId: string,
		turnId: string,
	) => Promise<ReviewLoopState | null>;
	readonly save: (sessionId: string, state: ReviewLoopState) => Promise<void>;
	/**
	 * The session's latest loop state (any turn): a handed-off one is
	 * continued by the turn its writer's report wakes.
	 */
	readonly latest?: (sessionId: string) => Promise<ReviewLoopState | null>;
	/** checkerMode=pair: the judge's workers (its child sessions). */
	readonly workers: (
		checkerSessionId: string,
	) => Promise<readonly LoopWorker[]>;
	/**
	 * Runs a command with the checker's own access (the product: as its
	 * reader user), for the loop to re-run its tests; default: vm.
	 */
	readonly checkerExec?: (
		checkerSessionId: string,
		command: string,
		timeoutMs: number,
	) => Promise<ShellResult>;
};

/** A pair judge's worker session as the loop reads it. */
export type LoopWorker = {
	readonly sessionId: string;
	readonly model?: ReviewWorker["model"];
	readonly items: unknown;
};

export type ReviewLoopInput = {
	readonly sessionId: string;
	readonly turnId: string;
	readonly workspace: () => Promise<AgentToolWorkspace>;
	readonly signal: AbortSignal;
	readonly billing: ModelBilling;
	/** The user's request this turn answers, verbatim. */
	readonly taskText: () => string;
	readonly deps: ReviewLoopDeps;
	/**
	 * Harness variant rigor=on: the checker's brief gets the rigor checks, and
	 * a final answer that admits unverified work while over half the loop's
	 * time is left is sent back even when the checker passes it. The
	 * builder's requirements list (its latest block this turn) goes to the
	 * checker as a claim and is kept on the round.
	 */
	readonly rigor?: boolean;
	/**
	 * Harness variant checkerMode=pair: each round's checker is a judge that
	 * briefs a cheaper worker (src/domain/checker-pair.ts); its brief adds
	 * the earlier rounds' findings, the round is still a full check, and
	 * the workers' spend counts as the checker's.
	 */
	readonly pair?: boolean;
	/**
	 * Harness variant checkerMode=blind: the checker derives the request's
	 * requirements and tests from the pre-work checkpoint before it looks at
	 * the deliverable (checker-brief.ts, blindReviewSection).
	 */
	readonly blind?: boolean;
	/**
	 * lead=fusion: Main's writer is still in a build round as Main's turn
	 * ends. Its work is not done, so the turn hands the loop off (no check);
	 * the turn the writer's report wakes continues it from this turn's
	 * checkpoint and checks the work then.
	 */
	readonly handedOff?: () => boolean;
	/**
	 * An unattended run (the eval bridge): nobody answers the builder. Every
	 * finished turn is checked, also without changed files in the checkout,
	 * and with rigor=on a final answer that asks the user to resolve
	 * something or admits a missing deliverable is sent back like unverified
	 * work.
	 */
	readonly unattended?: boolean;
};

type StepInput = {
	readonly messages: import("ai").ModelMessage[];
	readonly items: SessionItem[];
	/** Latest time this step may keep waiting. */
	readonly waitUntil: number;
};

type Taken = {
	readonly outcome: "completed" | "failed";
	readonly report: string;
	readonly timedOut?: boolean;
};

const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false";
/** After its budget, a checker gets this long to report (its forced final step) before the loop stops waiting. */
const REPORT_GRACE_MS = 90_000;
/** The loop's own re-runs of an ungrounded check's tests: per command, and in all. */
const HARNESS_RUN_MS = 90_000;
const HARNESS_TOTAL_MS = 4 * 60_000;

/** A round's checker scratch directory (its tests, findings file). */
export const reviewDirectory = (turnId: string, n: number) =>
	`${attemptDirectory(turnId, 0).replace(/\/0$/, "")}/review-${n}`;

export function reviewRef(turnId: string, label: string) {
	const safe = turnId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `refs/ytimesy/review/${safe || "turn"}-${label}`;
}

function spendOf(
	usage: ApiTokenUsage | null | undefined,
	billing: ModelBilling,
): AttemptSpend {
	if (!usage) return NO_ATTEMPT_SPEND;
	return {
		tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
		costUsd: usageCostUsd(usage, billing),
		estimated: billing.kind === "plan",
	};
}

const plus = (left: AttemptSpend, right: AttemptSpend): AttemptSpend => ({
	tokens: left.tokens + right.tokens,
	costUsd:
		left.costUsd === null || right.costUsd === null
			? null
			: left.costUsd + right.costUsd,
	estimated: left.estimated || right.estimated,
});

/**
 * Per round: the checker's spend (its own session, plus its workers' with
 * checkerMode=pair, split as judge and worker) and the fix's (the builder's
 * turn).
 */
export function reviewLoopSpend(state: ReviewLoopState, billing: ModelBilling) {
	const rounds = state.rounds.map((round) => {
		const judge = spendOf(
			round.checker.usage,
			childBilling(round.checker.model, billing),
		);
		const worker = (round.checker.workers ?? []).reduce(
			(sum, entry) =>
				plus(sum, spendOf(entry.usage, childBilling(entry.model, billing))),
			NO_ATTEMPT_SPEND,
		);
		return {
			n: round.n,
			checker: plus(judge, worker),
			judge,
			worker,
			fix: spendOf(round.fix?.usage, billing),
			checkMs:
				(round.checker.endedAt ?? round.checker.startedAt) -
				round.checker.startedAt,
			fixMs: round.fix?.endedAt ? round.fix.endedAt - round.fix.startedAt : 0,
		};
	});
	const total = (pick: (round: (typeof rounds)[number]) => AttemptSpend) =>
		rounds.reduce((sum, round) => plus(sum, pick(round)), NO_ATTEMPT_SPEND);
	return {
		rounds,
		checker: total((round) => round.checker),
		judge: total((round) => round.judge),
		worker: total((round) => round.worker),
		fix: total((round) => round.fix),
	};
}

/** How many tests the round's checker ran, for the chat's verdict card. */
function checkerTestsLine(round: ReviewRound | undefined): string[] {
	const tests = round?.verdict?.tests ?? [];
	if (!tests.length) return [];
	const failed = tests.filter((test) => !test.passed).length;
	return [`Checker tests: ${tests.length} run, ${failed} failed.`];
}

function summaryItem(
	state: ReviewLoopState,
	billing: ModelBilling,
	id: string,
	maxRounds: number,
	findingsOf?: ReviewRound,
): SessionItem {
	const spend = reviewLoopSpend(state, billing);
	const dollars = (value: number | null, estimated: boolean) =>
		value === null ? "" : ` · ${estimated ? "~" : ""}$${value.toFixed(2)}`;
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool: REVIEW_CHECK_TOOL,
		input: `independent review ${state.rounds.length} of up to ${maxRounds}`,
		output: [
			reviewLoopSummary(state),
			...(findingsOf?.findings.length
				? findingsOf.findings.map((finding) => `${finding.id}. ${finding.text}`)
				: []),
			...failingTests(findingsOf?.verdict ?? null).map(
				(test) =>
					`Failing test: ${test.name}${test.command ? ` (\`${test.command}\`)` : ""}`,
			),
			...checkerTestsLine(findingsOf ?? state.rounds.at(-1)),
			`Checker spent ${Math.round(spend.checker.tokens / 1000)}k tokens${dollars(spend.checker.costUsd, spend.checker.estimated)}${
				state.rounds.some((round) => round.checker.pair)
					? ` (judge ${Math.round(spend.judge.tokens / 1000)}k${dollars(spend.judge.costUsd, spend.judge.estimated)}, worker ${Math.round(spend.worker.tokens / 1000)}k${dollars(spend.worker.costUsd, spend.worker.estimated)})`
					: ""
			}.`,
		].join("\n"),
		status: "completed",
	};
}

export function createReviewLoop(input: ReviewLoopInput) {
	const { deps, sessionId, turnId } = input;
	const maxRounds = maxReviewRounds({ unattended: input.unattended });

	const save = async (state: ReviewLoopState) => {
		await deps.save(sessionId, state);
		return state;
	};

	/** rigor=on: the answer's admissions; unattended, also its questions to the user and missing deliverables first. */
	const admittedLines = (answer: string) =>
		input.unattended
			? [
					...new Set([
						...admittedUnfinished(answer),
						...admittedUnverified(answer),
					]),
				].slice(0, 3)
			: admittedUnverified(answer);

	const withRound = (
		state: ReviewLoopState,
		n: number,
		update: (round: ReviewRound) => ReviewRound,
	): ReviewLoopState => ({
		...state,
		rounds: state.rounds.map((round) =>
			round.n === n ? update(round) : round,
		),
	});

	/** A round's findings file ("" when there is none). */
	const findingsOf = async (n: number) => {
		const path = checkerFindingsPath(reviewDirectory(turnId, n));
		const read = await deps
			.vm(`tail -c 200000 ${quote(path)} 2>/dev/null || true`, 20_000)
			.catch(() => null);
		return read?.stdout ?? "";
	};

	/**
	 * The checker's tests and named checks, run by the loop itself with the
	 * checker's access, within HARNESS_TOTAL_MS and the loop's time less a fix.
	 */
	async function harnessRuns(
		verdict: ReviewVerdict,
		round: ReviewRound,
		deadlineAt: number,
	): Promise<HarnessRun[]> {
		const directory = reviewDirectory(turnId, round.n);
		const until = Math.min(
			deps.now() + HARNESS_TOTAL_MS,
			deadlineAt - REVIEW_LOOP_LIMITS.minFixMs,
		);
		const runs: HarnessRun[] = [];
		for (const { command, test } of harnessCommands(verdict, directory)) {
			const left = until - deps.now();
			if (left < 5_000 || input.signal.aborted) break;
			const wrapped = `cd ${quote(directory)} 2>/dev/null; ${command}`;
			const timeoutMs = Math.min(HARNESS_RUN_MS, left);
			const result = await (deps.checkerExec
				? deps.checkerExec(round.checker.sessionId, wrapped, timeoutMs)
				: deps.vm(wrapped, timeoutMs)
			).catch((error: unknown) => ({
				exitCode: -1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
			}));
			// A run that could not start is not evidence either way.
			if (result.exitCode < 0) continue;
			runs.push({
				command,
				exitCode: result.exitCode,
				output: `${result.stdout}${result.stderr ?? ""}`.trim().slice(-800),
				test,
			});
		}
		return runs;
	}

	/**
	 * Whether this turn still answers the handed-off turn's request: a turn
	 * woken by its writer's report (it carries no request of its own, or the
	 * same one), not a new user request.
	 */
	const continues = (carried: ReviewLoopState["carried"]) =>
		!!carried && (!input.taskText() || input.taskText() === carried.taskText);

	/** The request the loop checks: this turn's, else the handed-off turn's. */
	const requestText = (state: ReviewLoopState) =>
		input.taskText() || state.carried?.taskText || "";

	/** rigor=on: the builder's latest list this turn, else the handed-off turn's. */
	const requirementsOf = (state: ReviewLoopState, items: SessionItem[]) =>
		builderRequirements(items) ??
		(continues(state.carried) ? (state.carried?.requirements ?? null) : null);

	/**
	 * Step 1: the checkpoint, before the builder changes anything. A turn
	 * woken by the report of a writer a handed-off turn left working keeps
	 * that turn's checkpoint, request and list, so the check covers the
	 * writer's work; a new user request starts its own.
	 */
	async function begin() {
		const workspace = await input.workspace();
		const now = deps.now();
		const runner = await deps.runnerDeadline(sessionId).catch(() => null);
		const previous = await deps.latest?.(sessionId).catch(() => null);
		const continued =
			previous?.phase === "handed-off" &&
			previous.turnId !== turnId &&
			continues(previous.carried)
				? previous
				: null;
		const checkpoint =
			continued?.checkpoint ??
			(await deps.capture(workspace, reviewRef(turnId, "base")));
		return save({
			version: 1,
			kind: "review",
			turnId,
			phase: "building",
			startedAt: continued?.startedAt ?? now,
			deadlineAt: Math.min(
				now + REVIEW_LOOP_LIMITS.loopMinutes * 60_000,
				runner ?? Number.POSITIVE_INFINITY,
			),
			checkpoint,
			rounds: [],
			...(continued?.carried ? { carried: continued.carried } : {}),
		});
	}

	async function finish(
		state: ReviewLoopState,
		step: StepInput,
		outcome: ReviewOutcome,
		note?: string,
	): Promise<AttemptLoopOutcome> {
		const saved = await save({
			...state,
			phase: "done",
			outcome,
			...(note ? { note } : {}),
			finishedAt: deps.now(),
		});
		return {
			kind: "finished",
			messages: step.messages,
			items: saved.rounds.length
				? [
						...step.items,
						summaryItem(
							saved,
							input.billing,
							`review-loop:${turnId}:final`,
							maxRounds,
						),
					]
				: step.items,
		};
	}

	/**
	 * Unattended (an eval trial), the loop's window is not counted from the
	 * turn's start: a build that ran past the product's hour would get no
	 * review in a trial with hours left. At the first check it becomes the
	 * runner's deadline (the trial's remaining time, less the grader's
	 * margin), else the loop's minutes from now. The product keeps its hour
	 * from the turn's start: a person is waiting there.
	 */
	async function unattendedWindow(state: ReviewLoopState, now: number) {
		if (!input.unattended || state.rounds.length) return state;
		const runner = await deps.runnerDeadline(sessionId).catch(() => null);
		const deadlineAt = runner ?? now + REVIEW_LOOP_LIMITS.loopMinutes * 60_000;
		return deadlineAt === state.deadlineAt
			? state
			: save({ ...state, deadlineAt });
	}

	/** Step 2: capture the delivered tree and start its checker (or finish). */
	async function startCheck(
		current: ReviewLoopState,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const now = deps.now();
		const state = await unattendedWindow(current, now);
		const decision = decideCheck({
			checksDone: countedChecks(state.rounds),
			now,
			deadlineAt: state.deadlineAt,
			expectedCheckMs: expectedCheckMs(state),
			...(input.pair ? { pair: true } : {}),
			...(input.unattended ? { unattended: true } : {}),
		});
		if (decision.kind === "finish")
			return finish(
				state,
				step,
				decision.reason,
				decision.reason === "time"
					? "not enough time left for a check and a fix"
					: undefined,
			);
		const workspace = await input.workspace();
		const n = state.rounds.length + 1;
		const snapshot: AttemptSnapshot = await deps.capture(
			workspace,
			reviewRef(turnId, `r${n}`),
		);
		const previous = state.rounds.at(-1);
		// Unattended with nothing changed in the checkout, the deliverable is
		// outside it (or missing): an unchanged tree does not show the fix did nothing.
		if (
			previous &&
			previous.decision !== "retry" &&
			previous.snapshot.tree === snapshot.tree &&
			!(input.unattended && previous.changedFiles === 0)
		)
			return finish(state, step, "no-findings", "the fix changed no file");
		const changed = await deps.vm(
			`${GIT} -C ${quote(workspace.cwd)} diff --name-only ${quote(state.checkpoint.ref)} ${quote(snapshot.ref)}`,
			30_000,
		);
		const changedFiles = changed.stdout.split("\n").filter(Boolean);
		const eligible = reviewEligibility({
			changedFiles,
			turnMs: now - state.startedAt,
			...(input.unattended ? { unattended: true } : {}),
		});
		if (!eligible.review)
			return finish(state, step, "not-eligible", eligible.reason);
		const admitted =
			input.rigor &&
			(state.deadlineAt - now) / (state.deadlineAt - state.startedAt) >
				UNVERIFIED_SEND_BACK_TIME_LEFT
				? admittedLines(attemptReport(step.items))
				: [];
		const requirements = input.rigor ? requirementsOf(state, step.items) : null;
		const directory = reviewDirectory(turnId, n);
		const prepared = await deps.vm(checkerDirectoryCommand(directory), 20_000);
		if (prepared.exitCode !== 0)
			return finish(
				state,
				step,
				"check-failed",
				"the checker's directory could not be created",
			);
		let sessionIdOfChecker: string;
		let modelOfChecker: ReturnType<typeof loopChildModel>;
		try {
			const checker = await deps.startSubagent({
				role: "checker",
				title: `Review ${n} of ${maxRounds}`,
				...(input.pair ? { pair: true } : {}),
				brief: independentReviewBrief({
					taskText: requestText(state),
					checkout: workspace.cwd,
					changedFiles,
					scratch: directory,
					diffCommand: `git -C ${workspace.cwd} diff ${state.checkpoint.ref} ${snapshot.ref}`,
					rigor: input.rigor,
					...(input.blind ? { blindBaseRef: state.checkpoint.ref } : {}),
					...(requirements ? { builderRequirements: requirements } : {}),
					// A full check every round: the same brief, earlier findings as context.
					...(input.pair
						? {
								pair: true,
								previousFindings: state.rounds.flatMap((round) =>
									round.findings.map(
										(finding) =>
											`Review ${round.n}, ${finding.id}: ${finding.text}`,
									),
								),
							}
						: {}),
				}),
				cap: {
					...REVIEW_LOOP_LIMITS.checker,
					minutes: Math.max(1, decision.checkMs / 60_000),
				},
			});
			sessionIdOfChecker = checker.sessionId;
			modelOfChecker = loopChildModel(checker);
		} catch (error) {
			return finish(
				state,
				step,
				"check-failed",
				`no checker: ${error instanceof Error ? error.message.slice(0, 200) : "unavailable"}`,
			);
		}
		const checking = await save({
			...state,
			phase: "checking",
			rounds: [
				...state.rounds,
				{
					n,
					snapshot,
					changedFiles: changedFiles.length,
					checker: {
						sessionId: sessionIdOfChecker,
						...(modelOfChecker ? { model: modelOfChecker } : {}),
						...(input.pair ? { pair: true as const } : {}),
						startedAt: deps.now(),
						budgetMs: decision.checkMs,
					},
					verdict: null,
					...(admitted.length ? { admitted } : {}),
					...(requirements ? { builderRequirements: requirements } : {}),
					findings: [],
				},
			],
		});
		return awaitChecker(checking, step);
	}

	/**
	 * checkerMode=pair: the judge's workers with their spend and the commands
	 * they ran; any still running are stopped (the judge has answered).
	 */
	async function pairWorkers(checkerSessionId: string) {
		const sessions = await deps.workers(checkerSessionId).catch(() => []);
		return Promise.all(
			sessions.map(async (session) => {
				await deps.stopChild(session.sessionId).catch(() => {});
				const items = sessionItemsFromUnknown(session.items);
				return {
					sessionId: session.sessionId,
					...(session.model ? { model: session.model } : {}),
					usage: sessionTokenUsage(items),
					ran: ranCommandsText(items),
					executed: executedCommands(items),
				};
			}),
		);
	}

	/** Waits for the running checker's report until the step's deadline. */
	async function awaitChecker(
		state: ReviewLoopState,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const round = state.rounds.at(-1) as ReviewRound;
		const { sessionId: childId, startedAt, budgetMs } = round.checker;
		const stopAt = Math.min(startedAt + budgetMs, state.deadlineAt);
		const giveUpAt = Math.min(stopAt + REPORT_GRACE_MS, state.deadlineAt);
		let stopAsked = false;
		while (!input.signal.aborted) {
			const taken = await deps.takeReport(sessionId, childId);
			if (taken) return onReport(state, taken, step);
			const now = deps.now();
			// The child's own budget ends it; this only guards the loop's time.
			if (!stopAsked && now >= stopAt) {
				stopAsked = true;
				await deps.stopChild(childId).catch(() => {});
			}
			if (now >= giveUpAt)
				return onReport(
					state,
					{ outcome: "failed", report: "", timedOut: true },
					step,
				);
			if (now >= step.waitUntil) return { kind: "wait" };
			await deps.sleep(
				Math.min(
					3_000,
					Math.max(250, Math.min(step.waitUntil, giveUpAt) - now),
				),
				input.signal,
			);
		}
		input.signal.throwIfAborted();
		return { kind: "wait" };
	}

	/** Step 3: the verdict decides: finish, or the findings go back to the builder. */
	async function onReport(
		state: ReviewLoopState,
		taken: Taken,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const round = state.rounds.at(-1) as ReviewRound;
		const now = deps.now();
		const judgeLog = await deps
			.childItems(round.checker.sessionId)
			.catch(() => null);
		const judgeItems = sessionItemsFromUnknown(judgeLog ?? []);
		const usage = sessionTokenUsage(judgeItems);
		const workers = round.checker.pair
			? await pairWorkers(round.checker.sessionId)
			: null;
		const parsed: ReviewVerdict | null = taken.timedOut
			? null
			: parseReviewVerdict(taken.report);
		// No answer (cut off, or no verdict JSON): the findings file it kept.
		let answered = parsed?.parsed ? parsed : null;
		let via: VerdictVia = taken.report.includes(CHECKER_FORCED_FINAL_MARK)
			? "forced-final"
			: "normal";
		if (!answered) {
			answered = findingsFileVerdict(await findingsOf(round.n));
			if (answered) via = "findings-file";
		}
		// checkerMode=pair: the judge's verdict, its tests marked with who ran them.
		const paired =
			answered && workers
				? pairReviewVerdict(answered, {
						worker: workers.map((worker) => worker.ran).join("\n"),
						judge: ranCommandsText(judgeItems),
					})
				: answered;
		// Findings no command it (or its workers) ran shows are notes; an unshown pass is no verdict yet.
		let grounded = paired
			? groundReviewVerdict(
					paired,
					judgeLog === null
						? null
						: [
								...executedCommands(judgeItems),
								...(workers ?? []).flatMap((worker) => worker.executed),
							],
				)
			: null;
		// Ungrounded: the loop runs the checker's tests and named checks itself.
		if (grounded?.ungrounded)
			grounded = harnessGrounded(
				grounded,
				await harnessRuns(grounded, round, state.deadlineAt),
			);
		const retried = state.rounds.at(-2)?.decision === "retry";
		const checked: ReviewVerdict | null = grounded
			? {
					...grounded,
					via: grounded.via ?? (via === "normal" && retried ? "retry" : via),
				}
			: parsed;
		const noVerdict =
			!checked || checked.parsed === false || checked.ungrounded === true;
		// No verdict with ample time left: check the same tree again once.
		const retry =
			noVerdict &&
			retryCheck({
				verdict: checked,
				rounds: state.rounds,
				now,
				deadlineAt: state.deadlineAt,
				...(input.pair ? { pair: true } : {}),
				...(input.unattended ? { unattended: true } : {}),
			});
		// Still nothing run to show it (or no time to retry): pass, with the note.
		const verdict = noVerdict && !retry ? defaultPassVerdict(checked) : checked;
		const findings =
			verdict && !retry
				? reviewFindings(verdict, round.admitted, {
						unattended: input.unattended,
					})
				: [];
		const decision =
			verdict && !retry
				? decideAfterVerdict({
						verdict,
						findings,
						now,
						deadlineAt: state.deadlineAt,
						...(input.unattended
							? {
									unattended: true,
									previousFindings: state.rounds
										.slice(0, -1)
										.filter((earlier) => earlier.decision !== "retry")
										.at(-1)?.findings,
								}
							: {}),
					})
				: ({ kind: "finish", reason: "check-failed" } as const);
		const updated = withRound(state, round.n, (current) => ({
			...current,
			verdict,
			...(taken.timedOut ? { timedOut: true } : {}),
			findings,
			decision: retry
				? "retry"
				: decision.kind === "fix"
					? "fix"
					: decision.reason,
			checker: {
				...current.checker,
				endedAt: now,
				usage,
				...(workers
					? {
							workers: workers.map(
								({ ran: _ran, executed: _executed, ...worker }) => worker,
							),
						}
					: {}),
			},
		}));
		if (retry) return startCheck(await save(updated), step);
		if (decision.kind === "finish")
			return finish(
				updated,
				step,
				decision.reason,
				verdict?.via === "default-pass"
					? `not verified by running${taken.timedOut ? "; the checker gave no verdict in time" : ""}`
					: undefined,
			);
		const fixing = await save({
			...withRound(updated, round.n, (current) => ({
				...current,
				fix: { startedAt: now, usageAtStart: turnUsage(step.items) },
			})),
			phase: "fixing",
		});
		const fixingRound = fixing.rounds.at(-1) as ReviewRound;
		return {
			kind: "run",
			messages: [
				...step.messages,
				{
					role: "user",
					content: reviewNotice({
						round: round.n,
						maxRounds,
						findings,
						failingTests: failingTests(verdict),
					}),
				},
			],
			items: [
				...step.items,
				summaryItem(
					fixing,
					input.billing,
					`review-loop:${turnId}:${round.n}`,
					maxRounds,
					fixingRound,
				),
			],
		};
	}

	return {
		/** Before a model step: start the loop or resume waiting for the checker. */
		async beforeModel(step: StepInput): Promise<AttemptLoopOutcome> {
			const state = await deps.load(sessionId, turnId);
			if (!state) {
				await begin();
				return { kind: "run" };
			}
			if (state.phase === "checking") return awaitChecker(state, step);
			return { kind: "run" };
		},

		/** The builder declared the turn complete (final answer, completion gates passed). */
		async afterAttempt(step: StepInput): Promise<AttemptLoopOutcome> {
			let state = await deps.load(sessionId, turnId);
			// Started without a checkpoint (enabled mid-turn): nothing to diff against.
			if (!state || state.phase === "done")
				return { kind: "finished", messages: step.messages, items: step.items };
			if (state.phase === "checking") return awaitChecker(state, step);
			if (
				(state.phase === "building" || state.phase === "handed-off") &&
				input.handedOff?.()
			) {
				const list = input.rigor ? requirementsOf(state, step.items) : null;
				await save({
					...state,
					phase: "handed-off",
					carried: {
						turnId: state.carried?.turnId ?? turnId,
						taskText: requestText(state),
						...(list ? { requirements: list } : {}),
					},
				});
				return { kind: "finished", messages: step.messages, items: step.items };
			}
			if (state.phase === "fixing") {
				const round = state.rounds.at(-1) as ReviewRound;
				const fix = round.fix;
				state = await save(
					withRound(state, round.n, (current) => ({
						...current,
						fix: fix && {
							...fix,
							endedAt: deps.now(),
							usage: usageSince(turnUsage(step.items), fix.usageAtStart),
							responses: findingResponses(
								attemptReport(step.items),
								current.findings,
							),
						},
					})),
				);
			}
			return startCheck(state, step);
		},
	};
}

export type ReviewLoop = ReturnType<typeof createReviewLoop>;
