import type { ModelMessage } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import type {
	AttemptSnapshot,
	LoopChildModel,
} from "../../src/domain/attempt-loop";
import { SessionItemId } from "../../src/domain/ids";
import type { ModelBilling } from "../../src/domain/model-pricing";
import type { ReviewLoopState } from "../../src/domain/review-loop";
import type { SessionItem } from "../../src/domain/session-item";
import { subagentBudgetCheck } from "../../src/domain/sidekick";
import type { SubagentBudget } from "../../src/domain/subagent";
import { subagentWrapUpNotice } from "../../src/domain/subagent-instructions";
import { usageTokens } from "../../src/domain/subagent-usage";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { captureConversationCode } from "../../src/server/services/conversation-code-checkpoint";
import {
	createReviewLoop,
	type ReviewLoopDeps,
} from "../../src/server/services/review-loop";
import type { TimedEvent, TrialRole, TrialSessions } from "./sessions";
import { lastUsage, runsUsage } from "./trial";

/**
 * review=on inside a Harbor trial: the product's review loop
 * (src/server/services/review-loop.ts, unchanged) with in-process
 * dependencies instead of the api-turn job stack's database:
 *   - loop state lives in memory (a trial is one process, never resumed),
 *   - the checker is a second model run in this process on the same task
 *     container (startChecker), not a database-backed subagent session,
 *   - its report is its final message; its usage is its own events.
 *
 * Difference from the product: the product's checker runs its commands as
 * a reader Linux user that cannot write the checkout. In the bridge the
 * checker (and a pair judge's workers) work in their own cp -a copy of the
 * checkout (trial.ts readerCopyCommand); nothing is restored afterwards.
 */

export type CheckerRun = {
	/** The checker's final message, or "" when it failed. */
	readonly done: Promise<{ outcome: "completed" | "failed"; report: string }>;
	readonly usage: () => ApiTokenUsage | null;
	readonly stop: () => void;
};

export type StartChecker = (input: {
	sessionId: string;
	brief: string;
	budget: SubagentBudget;
}) => CheckerRun;

export type ReviewTrace = {
	/** The loop's last saved state (rounds, verdicts, the checker's model). */
	state?: ReviewLoopState | null;
	checks: {
		sessionId: string;
		snapshot: string;
	}[];
};

export function harborReviewDeps(input: {
	workspace: AgentToolWorkspace;
	deadlineAt: number | null;
	startChecker: StartChecker;
	trace: ReviewTrace;
	/** roleModels.checker: recorded in the loop's rounds so its spend is priced at that model. */
	checkerModel?: Omit<LoopChildModel, "notice">;
	/** checkerMode=pair: the trial's sessions, where a judge's workers are. */
	sessions?: TrialSessions;
	now?: () => number;
}): ReviewLoopDeps {
	let state: ReviewLoopState | null = null;
	let lastSnapshot: AttemptSnapshot | null = null;
	const checkers = new Map<
		string,
		CheckerRun & {
			settled: { outcome: "completed" | "failed"; report: string } | null;
			snapshot: AttemptSnapshot | null;
		}
	>();
	let next = 0;
	return {
		now: input.now ?? (() => Date.now()),
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				}
				signal.addEventListener("abort", done, { once: true });
			}),
		load: async () => state,
		save: async (_sessionId, saved) => {
			state = saved;
			input.trace.state = saved;
		},
		runnerDeadline: async () => input.deadlineAt,
		capture: async (workspace, ref) => {
			lastSnapshot = await captureConversationCode(workspace, ref);
			return lastSnapshot;
		},
		startSubagent: async (spec) => {
			const sessionId = `harbor-checker-${++next}`;
			const budget = {
				steps: spec.cap.steps ?? 60,
				minutes: spec.cap.minutes ?? 10,
				tokens: spec.cap.tokens ?? 800_000,
			};
			const run = input.startChecker({ sessionId, brief: spec.brief, budget });
			const entry = {
				...run,
				settled: null as {
					outcome: "completed" | "failed";
					report: string;
				} | null,
				snapshot: lastSnapshot,
			};
			checkers.set(sessionId, entry);
			void run.done.then(
				(result) => {
					// The checker worked in its own copy: nothing to undo here.
					input.trace.checks.push({
						sessionId,
						snapshot: entry.snapshot?.ref ?? "",
					});
					entry.settled = result;
				},
				() => {
					entry.settled = { outcome: "failed", report: "" };
				},
			);
			return input.checkerModel
				? { sessionId, model: input.checkerModel }
				: { sessionId };
		},
		takeReport: async (_parent, child) => {
			return checkers.get(child)?.settled ?? null;
		},
		childItems: async (child) => {
			const usage = checkers.get(child)?.usage() ?? null;
			return [
				...commandItems(child, input.sessions?.get(child)?.events ?? []),
				...(usage
					? [
							{
								kind: "userMessage" as const,
								id: SessionItemId(`${child}-usage`),
								text: "",
								apiUsage: usage,
							},
						]
					: []),
			];
		},
		stopChild: async (child) => {
			checkers.get(child)?.stop();
		},
		workers: async (judgeId) =>
			(input.sessions?.children(judgeId) ?? [])
				.filter((worker) => worker.role === "checkerWorker")
				.map((worker) => {
					const usage = runsUsage(worker.events, worker.starts);
					return {
						sessionId: worker.id,
						model: {
							harness: worker.model.billing.kind === "plan" ? "codex" : "api",
							modelId: worker.model.modelId,
							reasoning: worker.model.effort,
						},
						// Its commands, so the judge's tests are marked with who ran them.
						items: [
							...commandItems(worker.id, worker.events),
							...(usage
								? [
										{
											kind: "userMessage",
											id: SessionItemId(`${worker.id}-usage`),
											text: "",
											apiUsage: usage,
										},
									]
								: []),
						],
					};
				}),
		vm: (command, timeoutMs) =>
			input.workspace.machines.exec(input.workspace.vm, command, timeoutMs),
	};
}

/** A session's tool calls as items (ranCommandsText reads the command, else the input). */
export function commandItems(
	sessionId: string,
	events: readonly { event: ApiAgentEvent }[],
): SessionItem[] {
	return events.flatMap(({ event }, index) => {
		if (event.type !== "tool-call") return [];
		const input = event.input as { command?: unknown; code?: unknown } | null;
		const text =
			typeof input?.command === "string"
				? input.command
				: typeof input?.code === "string"
					? input.code
					: typeof event.input === "string"
						? event.input
						: JSON.stringify(event.input ?? "");
		return [
			{
				kind: "dynamicToolCall" as const,
				id: SessionItemId(`${sessionId}-call-${index}`),
				tool: event.name,
				input: text,
				status: "completed" as const,
			},
		];
	});
}

/** The builder's turn as the review loop reads it: the request with its usage, then the final answer. */
export function reviewItems(input: {
	instruction: string;
	usage: ApiTokenUsage | null;
	messages: readonly ModelMessage[];
}): SessionItem[] {
	return [
		{
			kind: "userMessage",
			id: SessionItemId("harbor-request"),
			text: input.instruction,
			...(input.usage ? { apiUsage: input.usage } : {}),
		},
		{
			kind: "agentMessage",
			id: SessionItemId("harbor-answer"),
			text: finalAnswer(input.messages),
		},
	];
}

/** The last assistant message's text. */
export function finalAnswer(messages: readonly ModelMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

/** A child's round stopped at its token budget (the product's SubagentBudgetExhausted). */
export class ChildBudgetUsed extends Error {
	constructor(
		readonly role: TrialRole,
		readonly reason: string,
	) {
		super(`${CHILD_ROLE_LABELS[role]} budget used (${reason}).`);
		this.name = "ChildBudgetUsed";
	}
}

const CHILD_ROLE_LABELS: Record<TrialRole, string> = {
	sidekick: "Sidekick",
	checker: "Checker",
	checkerWorker: "Checker worker",
	classifier: "Classifier",
};

/** The ChildBudgetUsed anywhere in an error's cause chain. */
export function childBudgetUsed(error: unknown): ChildBudgetUsed | null {
	for (let current = error, depth = 0; current && depth < 8; depth++) {
		if (current instanceof ChildBudgetUsed) return current;
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

/**
 * A child's per-step budget checks in one round, as the product's subagent
 * guard does: a wrap-up notice once 90% of its steps, minutes or tokens are
 * used (the minutes notice a minute earlier, so a verdict still fits), and a
 * stop at its token budget. Tokens are this round's own: usage events are
 * cumulative within one model run, so the last one since the round's first
 * event, never an earlier round's; weighted like the product's budget tokens.
 * A sidekick's token cap is the product's per-round cap (subagentBudgetCheck),
 * not its budget across rounds.
 */
export function childStepGuard(input: {
	role: TrialRole;
	budget: SubagentBudget;
	startedAt: number;
	events: readonly TimedEvent[];
	/** The round's first event index. */
	from: number;
	/** budgetTokenWeight of the child's model against the builder's. */
	weight?: number;
	now?: () => number;
}) {
	let steps = 0;
	let warned = false;
	const limit = subagentBudgetCheck(
		input.budget,
		{ steps: 0, tokens: 0, createdAt: new Date(input.startedAt).toISOString() },
		input.startedAt,
	).limits.tokens;
	const prefix = input.budget.sidekick ? "this round, " : "";
	const count = (value: number) => Math.round(value).toLocaleString("en-US");
	return async (messages: ModelMessage[]): Promise<ModelMessage[]> => {
		steps++;
		const now = (input.now ?? Date.now)();
		const tokens =
			usageTokens(lastUsage(input.events, input.from)) * (input.weight ?? 1);
		if (tokens >= limit)
			throw new ChildBudgetUsed(
				input.role,
				`${prefix}tokens ${count(tokens)}/${count(limit)}`,
			);
		const elapsedMinutes = (now - input.startedAt) / 60_000;
		const reason =
			steps >= Math.ceil(input.budget.steps * 0.9)
				? `${steps} of ${input.budget.steps} steps`
				: elapsedMinutes >= input.budget.minutes * 0.9 - 1
					? `${elapsedMinutes.toFixed(1)} of ${input.budget.minutes} minutes`
					: tokens >= limit * 0.9
						? `${count(tokens)} of ${count(limit)} tokens`
						: null;
		if (!reason || warned) return messages;
		warned = true;
		return [
			...messages,
			{
				role: "user",
				content: subagentWrapUpNotice(
					`${prefix}${reason}`,
					input.role === "sidekick" ? "writer" : "checker",
				),
			},
		];
	};
}

export type HarborReviewLoop = ReturnType<typeof createReviewLoop>;

export function harborReviewLoop(input: {
	rigor?: boolean;
	pair?: boolean;
	sessionId: string;
	turnId: string;
	workspace: AgentToolWorkspace;
	signal: AbortSignal;
	billing: ModelBilling;
	instruction: string;
	deps: ReviewLoopDeps;
}) {
	return createReviewLoop({
		sessionId: input.sessionId,
		turnId: input.turnId,
		workspace: async () => input.workspace,
		signal: input.signal,
		billing: input.billing,
		taskText: () => input.instruction,
		deps: input.deps,
		rigor: input.rigor,
		pair: input.pair,
	});
}
