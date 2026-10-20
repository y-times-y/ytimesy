import type { ApiTokenUsage } from "#/domain/api-token-usage";
import {
	type AttemptSnapshot,
	type AttemptSpend,
	attemptDirectory,
	NO_ATTEMPT_SPEND,
	usageSince,
} from "#/domain/attempt-loop";
import {
	independentReviewBrief,
	parseReviewVerdict,
	type ReviewVerdict,
} from "#/domain/checker-brief";
import { SessionItemId } from "#/domain/ids";
import { type ModelBilling, usageCostUsd } from "#/domain/model-pricing";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	decideAfterVerdict,
	decideCheck,
	expectedCheckMs,
	failingTests,
	findingResponses,
	REVIEW_LOOP_LIMITS,
	type ReviewLoopState,
	type ReviewOutcome,
	type ReviewRound,
	reviewEligibility,
	reviewFindings,
	reviewLoopSummary,
	reviewNotice,
} from "#/domain/review-loop";
import {
	admittedUnverified,
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
 * 3. Decide: pass finishes. Fail or unsure with concrete findings and time
 *    left adds one runtime notice with the findings to the same run and the
 *    builder continues; nothing is reset. Up to two rounds per turn.
 *    Anything else finishes. With rigor=on, a final answer that admitted
 *    unverified work while over half the time was left is a finding too,
 *    and is sent back even after a pass.
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
	 * time is left is sent back even when the checker passes it.
	 */
	readonly rigor?: boolean;
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
/** After its budget, a checker gets this long to report before the loop stops waiting. */
const REPORT_GRACE_MS = 60_000;

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

/** Per round: the checker's spend (its own session) and the fix's (the builder's turn). */
export function reviewLoopSpend(state: ReviewLoopState, billing: ModelBilling) {
	const rounds = state.rounds.map((round) => ({
		n: round.n,
		checker: spendOf(
			round.checker.usage,
			childBilling(round.checker.model, billing),
		),
		fix: spendOf(round.fix?.usage, billing),
		checkMs:
			(round.checker.endedAt ?? round.checker.startedAt) -
			round.checker.startedAt,
		fixMs: round.fix?.endedAt ? round.fix.endedAt - round.fix.startedAt : 0,
	}));
	return {
		rounds,
		checker: rounds.reduce(
			(sum, round) => plus(sum, round.checker),
			NO_ATTEMPT_SPEND,
		),
		fix: rounds.reduce((sum, round) => plus(sum, round.fix), NO_ATTEMPT_SPEND),
	};
}

function summaryItem(
	state: ReviewLoopState,
	billing: ModelBilling,
	id: string,
	findingsOf?: ReviewRound,
): SessionItem {
	const spend = reviewLoopSpend(state, billing);
	const dollars = (value: number | null, estimated: boolean) =>
		value === null ? "" : ` · ${estimated ? "~" : ""}$${value.toFixed(2)}`;
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool: "review_check",
		input: `independent review ${state.rounds.length} of up to ${REVIEW_LOOP_LIMITS.maxRounds}`,
		output: [
			reviewLoopSummary(state),
			...(findingsOf?.findings.length
				? findingsOf.findings.map((finding) => `${finding.id}. ${finding.text}`)
				: []),
			...failingTests(findingsOf?.verdict ?? null).map(
				(test) =>
					`Failing test: ${test.name}${test.command ? ` (\`${test.command}\`)` : ""}`,
			),
			`Checker spent ${Math.round(spend.checker.tokens / 1000)}k tokens${dollars(spend.checker.costUsd, spend.checker.estimated)}.`,
		].join("\n"),
		status: "completed",
	};
}

export function createReviewLoop(input: ReviewLoopInput) {
	const { deps, sessionId, turnId } = input;

	const save = async (state: ReviewLoopState) => {
		await deps.save(sessionId, state);
		return state;
	};

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

	/** Step 1: the checkpoint, before the builder changes anything. */
	async function begin() {
		const workspace = await input.workspace();
		const now = deps.now();
		const runner = await deps.runnerDeadline(sessionId).catch(() => null);
		const checkpoint = await deps.capture(workspace, reviewRef(turnId, "base"));
		return save({
			version: 1,
			kind: "review",
			turnId,
			phase: "building",
			startedAt: now,
			deadlineAt: Math.min(
				now + REVIEW_LOOP_LIMITS.loopMinutes * 60_000,
				runner ?? Number.POSITIVE_INFINITY,
			),
			checkpoint,
			rounds: [],
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
						summaryItem(saved, input.billing, `review-loop:${turnId}:final`),
					]
				: step.items,
		};
	}

	/** Step 2: capture the delivered tree and start its checker (or finish). */
	async function startCheck(
		state: ReviewLoopState,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const now = deps.now();
		const decision = decideCheck({
			checksDone: state.rounds.length,
			now,
			deadlineAt: state.deadlineAt,
			expectedCheckMs: expectedCheckMs(state),
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
		if (previous && previous.snapshot.tree === snapshot.tree)
			return finish(state, step, "no-findings", "the fix changed no file");
		const changed = await deps.vm(
			`${GIT} -C ${quote(workspace.cwd)} diff --name-only ${quote(state.checkpoint.ref)} ${quote(snapshot.ref)}`,
			30_000,
		);
		const changedFiles = changed.stdout.split("\n").filter(Boolean);
		const eligible = reviewEligibility({
			changedFiles,
			turnMs: now - state.startedAt,
		});
		if (!eligible.review)
			return finish(state, step, "not-eligible", eligible.reason);
		const admitted =
			input.rigor &&
			(state.deadlineAt - now) / (state.deadlineAt - state.startedAt) >
				UNVERIFIED_SEND_BACK_TIME_LEFT
				? admittedUnverified(attemptReport(step.items))
				: [];
		const directory = `${attemptDirectory(turnId, 0).replace(/\/0$/, "")}/review-${n}`;
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
				title: `Review ${n} of ${REVIEW_LOOP_LIMITS.maxRounds}`,
				brief: independentReviewBrief({
					taskText: input.taskText(),
					checkout: workspace.cwd,
					changedFiles,
					scratch: directory,
					diffCommand: `git -C ${workspace.cwd} diff ${state.checkpoint.ref} ${snapshot.ref}`,
					rigor: input.rigor,
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
						startedAt: deps.now(),
						budgetMs: decision.checkMs,
					},
					verdict: null,
					...(admitted.length ? { admitted } : {}),
					findings: [],
				},
			],
		});
		return awaitChecker(checking, step);
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
		const verdict: ReviewVerdict | null = taken.timedOut
			? null
			: parseReviewVerdict(taken.report);
		const findings = verdict ? reviewFindings(verdict, round.admitted) : [];
		const usage = sessionTokenUsage(
			sessionItemsFromUnknown(
				await deps.childItems(round.checker.sessionId).catch(() => []),
			),
		);
		const decision = verdict
			? decideAfterVerdict({
					verdict,
					findings,
					now,
					deadlineAt: state.deadlineAt,
				})
			: ({ kind: "finish", reason: "check-failed" } as const);
		const updated = withRound(state, round.n, (current) => ({
			...current,
			verdict,
			...(taken.timedOut ? { timedOut: true } : {}),
			findings,
			decision: decision.kind === "fix" ? "fix" : decision.reason,
			checker: { ...current.checker, endedAt: now, usage },
		}));
		if (decision.kind === "finish")
			return finish(
				updated,
				step,
				decision.reason,
				taken.timedOut ? "the checker gave no verdict in time" : undefined,
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
						maxRounds: REVIEW_LOOP_LIMITS.maxRounds,
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
