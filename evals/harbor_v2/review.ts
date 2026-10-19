import type { ModelMessage } from "ai";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import type { AttemptSnapshot } from "../../src/domain/attempt-loop";
import { SessionItemId } from "../../src/domain/ids";
import type { ModelBilling } from "../../src/domain/model-pricing";
import type { ReviewLoopState } from "../../src/domain/review-loop";
import type { SessionItem } from "../../src/domain/session-item";
import type { SubagentBudget } from "../../src/domain/subagent";
import { subagentWrapUpNotice } from "../../src/domain/subagent-instructions";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import {
	captureConversationCode,
	restoreConversationCode,
} from "../../src/server/services/conversation-code-checkpoint";
import {
	createReviewLoop,
	type ReviewLoopDeps,
} from "../../src/server/services/review-loop";

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
 * a reader Linux user that cannot write the checkout. A Harbor container
 * has no such user, so after each check the checkout is restored to the
 * tree the checker was given (restoreConversationCode); anything the
 * checker changed in the checkout is undone before the builder continues.
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
	checks: {
		sessionId: string;
		snapshot: string;
		restored: boolean | "failed";
	}[];
};

export function harborReviewDeps(input: {
	workspace: AgentToolWorkspace;
	deadlineAt: number | null;
	startChecker: StartChecker;
	trace: ReviewTrace;
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
				async (result) => {
					// Undo anything the checker changed in the checkout before the
					// loop reads its report and the builder continues.
					const record = {
						sessionId,
						snapshot: entry.snapshot?.ref ?? "",
						restored: false as boolean | "failed",
					};
					if (entry.snapshot)
						try {
							await restoreConversationCode(input.workspace, entry.snapshot);
							record.restored = true;
						} catch {
							record.restored = "failed";
						}
					input.trace.checks.push(record);
					entry.settled = result;
				},
				() => {
					entry.settled = { outcome: "failed", report: "" };
				},
			);
			return { sessionId };
		},
		takeReport: async (_parent, child) => {
			return checkers.get(child)?.settled ?? null;
		},
		childItems: async (child) => {
			const usage = checkers.get(child)?.usage() ?? null;
			return usage
				? [
						{
							kind: "userMessage",
							id: SessionItemId(`${child}-usage`),
							text: "",
							apiUsage: usage,
						},
					]
				: [];
		},
		stopChild: async (child) => {
			checkers.get(child)?.stop();
		},
		vm: (command, timeoutMs) =>
			input.workspace.machines.exec(input.workspace.vm, command, timeoutMs),
	};
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

/**
 * The checker's per-step budget checks, as the product's subagent guard
 * does: a wrap-up notice once 90% of its steps or minutes are used (the
 * minutes notice a minute earlier, so a verdict still fits), and a stop at
 * its token budget.
 */
export function checkerStepGuard(input: {
	budget: SubagentBudget;
	startedAt: number;
	usage: () => ApiTokenUsage | null;
	now?: () => number;
}) {
	let steps = 0;
	let warned = false;
	return async (messages: ModelMessage[]): Promise<ModelMessage[]> => {
		steps++;
		const now = (input.now ?? Date.now)();
		const usage = input.usage();
		const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
		if (tokens >= input.budget.tokens)
			throw new Error(`Checker token budget used (${tokens}).`);
		const elapsedMinutes = (now - input.startedAt) / 60_000;
		const reason =
			steps >= Math.ceil(input.budget.steps * 0.9)
				? `${steps} of ${input.budget.steps} steps`
				: elapsedMinutes >= input.budget.minutes * 0.9 - 1
					? `${elapsedMinutes.toFixed(1)} of ${input.budget.minutes} minutes`
					: tokens >= input.budget.tokens * 0.9
						? `${tokens} of ${input.budget.tokens} tokens`
						: null;
		if (!reason || warned) return messages;
		warned = true;
		return [
			...messages,
			{ role: "user", content: subagentWrapUpNotice(reason, "checker") },
		];
	};
}

export type HarborReviewLoop = ReturnType<typeof createReviewLoop>;

export function harborReviewLoop(input: {
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
	});
}
