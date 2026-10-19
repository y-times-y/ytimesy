import { modelBilling, usageCostUsd } from "./model-pricing";
import { type SubagentTreeSession, subagentTree } from "./subagent-tree";
import type { AgentSpend } from "./subagent-usage";

/**
 * Cost per eval attempt and per solved task, shared by the eval scripts
 * (native-vs-harness, model-smoke-suite, the memory evals, the hard-set
 * runner). An attempt's cost is its whole agent tree: the builder plus every
 * subagent, with forked writers' VM minutes. Plan-billed routes (a Codex
 * subscription) are priced at list price and labelled as an estimate.
 */
export type AttemptCost = {
	readonly solved: boolean;
	readonly tokens: number;
	/** Null when some model in the tree has no known price. */
	readonly costUsd: number | null;
	/** costUsd is a list-price estimate (some of the tree ran on a plan). */
	readonly estimated: boolean;
	readonly vmMinutes: number;
	/** Agents in the tree, the builder included. */
	readonly agents: number;
};

export function attemptCostFromSpend(
	spend: AgentSpend,
	solved: boolean,
	agents = 1,
): AttemptCost {
	return {
		solved,
		tokens: spend.tokens,
		costUsd: spend.costUsd,
		estimated: spend.planBilled,
		vmMinutes: spend.vmMinutes,
		agents,
	};
}

/** An attempt's cost from its stored sessions: the root (the builder) and its descendants. */
export function attemptCostFromSessions(input: {
	readonly rootId: string;
	readonly sessions: readonly SubagentTreeSession[];
	readonly solved: boolean;
	readonly now?: number;
}): AttemptCost {
	const tree = subagentTree(
		input.rootId,
		input.sessions,
		input.now ?? Date.now(),
	);
	return attemptCostFromSpend(tree.total, input.solved, tree.nodes.length + 1);
}

/** The run-record shape the eval scripts share (scripts/smoke/builder-harness.ts RunRecord). */
export type CostedRun = {
	readonly verifierPassed: boolean | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly costUsd?: number | null;
	readonly costEstimated?: boolean;
	readonly treeTokens?: number;
	readonly vmMinutes?: number;
	readonly agents?: number;
};

export function attemptCostFromRun(run: CostedRun): AttemptCost {
	return {
		solved: run.verifierPassed === true,
		tokens: run.treeTokens || (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
		costUsd: run.costUsd ?? null,
		estimated: run.costEstimated ?? false,
		vmMinutes: run.vmMinutes ?? 0,
		agents: run.agents ?? 1,
	};
}

/**
 * Dollars for one run's token counts at the model's list price: a charge on
 * an API route, an estimate (`estimated`) on a plan route such as a Codex
 * subscription or the native Codex CLI. Null when the price is unknown.
 */
export function runListPrice(input: {
	readonly harness: "codex" | "api";
	readonly modelId: string;
	readonly inputTokens: number | null;
	readonly cachedTokens: number | null;
	readonly outputTokens: number | null;
}) {
	const billing = modelBilling(input);
	return {
		costUsd: usageCostUsd(
			{
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				cacheReadTokens: input.cachedTokens,
				cacheWriteTokens: 0,
				uncachedInputTokens: null,
			},
			billing,
		),
		estimated: billing.kind === "plan",
	};
}

export type CostSummary = {
	readonly attempts: number;
	readonly solved: number;
	readonly totalUsd: number | null;
	readonly perAttemptUsd: number | null;
	/** Total spend over every attempt divided by the solved ones: failures are paid for too. */
	readonly perSolvedUsd: number | null;
	readonly tokensPerAttempt: number;
	readonly tokensPerSolved: number | null;
	readonly vmMinutesPerAttempt: number;
	readonly meanAgents: number;
	/** How to read the dollars. */
	readonly basis: "billed" | "list-price estimate" | "mixed" | "unknown";
};

export function costSummary(attempts: readonly AttemptCost[]): CostSummary {
	const count = attempts.length;
	const solved = attempts.filter((attempt) => attempt.solved).length;
	const tokens = attempts.reduce((sum, attempt) => sum + attempt.tokens, 0);
	const totalUsd = attempts.some((attempt) => attempt.costUsd === null)
		? null
		: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
	const estimated = attempts.filter((attempt) => attempt.estimated).length;
	return {
		attempts: count,
		solved,
		totalUsd,
		perAttemptUsd: totalUsd === null || !count ? null : totalUsd / count,
		perSolvedUsd: totalUsd === null || !solved ? null : totalUsd / solved,
		tokensPerAttempt: count ? Math.round(tokens / count) : 0,
		tokensPerSolved: solved ? Math.round(tokens / solved) : null,
		vmMinutesPerAttempt: count
			? attempts.reduce((sum, attempt) => sum + attempt.vmMinutes, 0) / count
			: 0,
		meanAgents: count
			? attempts.reduce((sum, attempt) => sum + attempt.agents, 0) / count
			: 0,
		basis:
			totalUsd === null
				? "unknown"
				: !estimated
					? "billed"
					: estimated === count
						? "list-price estimate"
						: "mixed",
	};
}

function dollars(value: number | null, basis: CostSummary["basis"]) {
	if (value === null) return "-";
	const text = `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
	return basis === "billed" ? text : `~${text}`;
}

/** Table cells for a report row; an estimate is marked with ~ and named in `note`. */
export function costSummaryCells(summary: CostSummary) {
	return {
		perAttempt: dollars(summary.perAttemptUsd, summary.basis),
		perSolved: dollars(summary.perSolvedUsd, summary.basis),
		tokensPerSolved:
			summary.tokensPerSolved === null ? "-" : String(summary.tokensPerSolved),
		vmMinutes: summary.vmMinutesPerAttempt
			? summary.vmMinutesPerAttempt.toFixed(1)
			: "0",
		note:
			summary.basis === "billed"
				? ""
				: summary.basis === "unknown"
					? "$ unknown: a model has no known price"
					: "~$ = list-price estimate for plan-billed routes, not a charge",
	};
}

/** One line for logs: `$/attempt ~$0.12 · $/solved ~$0.30 (3/5 solved) · 210k tok/attempt`. */
export function formatCostSummary(summary: CostSummary) {
	const cells = costSummaryCells(summary);
	return [
		`$/attempt ${cells.perAttempt}`,
		`$/solved ${cells.perSolved} (${summary.solved}/${summary.attempts} solved)`,
		`${Math.round(summary.tokensPerAttempt / 1000)}k tok/attempt`,
		...(summary.vmMinutesPerAttempt
			? [`${cells.vmMinutes} fork VM min/attempt`]
			: []),
		...(summary.meanAgents > 1
			? [`${summary.meanAgents.toFixed(1)} agents/attempt`]
			: []),
		...(cells.note ? [`(${cells.note})`] : []),
	].join(" · ");
}
