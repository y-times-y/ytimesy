import { sessionBilling, usageCostUsd } from "./model-pricing";
import { sessionItemsFromUnknown } from "./session-item";
import type { SubagentRole } from "./subagent";
import { sessionTokenUsage } from "./subagent-usage";

/**
 * An Artificial-Analysis-style efficiency block for eval runs (the hard-set
 * runner; any runner that keeps the session tree can use it): per run or arm
 * the average cost per task, cost per solved task, tokens, model calls,
 * cache hit rate and time per task, and the spend split by who spent it
 * (builder, subagents, checker, judge) and on which model.
 */

export type SpendRole = "builder" | "subagent" | "checker" | "judge";
const ROLE_ORDER: readonly SpendRole[] = [
	"builder",
	"subagent",
	"checker",
	"judge",
];

/** One (role, model) pair's spend in one run. */
export type ModelSpendRow = {
	readonly role: SpendRole;
	/** The session's listed model (a Codex slug or an API route's model id). */
	readonly model: string;
	readonly agents: number;
	/** Model calls; null when an older record did not count them. */
	readonly requests: number | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	/** At each session's own route price; null when a price is unknown. */
	readonly costUsd: number | null;
	/** A list-price estimate (plan-billed route), not a charge. */
	readonly estimated: boolean;
};

/** The session fields the breakdown reads (AgentSessionRecord satisfies it). */
export type SpendSession = {
	readonly id: string;
	readonly harness: string;
	readonly listedModelId: string | null;
	readonly items: unknown;
	readonly agentRole?: SubagentRole | null;
};

const plusNull = (a: number | null, b: number | null) =>
	a === null || b === null ? null : a + b;

function modelLabel(listedModelId: string | null) {
	if (!listedModelId) return "?";
	const route = /^api\/[^/]+\/(.+)$/.exec(listedModelId);
	if (!route) return listedModelId;
	try {
		return decodeURIComponent(route[1]);
	} catch {
		return listedModelId;
	}
}

/**
 * A run's spend per role and model from its session tree: the root is the
 * builder; the loops' tiebreak judges (by id) are the judge; checker-role
 * sessions are the checker; every other child is a subagent.
 */
export function treeModelSpend(input: {
	readonly rootId: string;
	readonly sessions: readonly SpendSession[];
	readonly judgeIds?: ReadonlySet<string>;
}): ModelSpendRow[] {
	return treeRowsMerge(
		input.sessions.map((session) => {
			const usage = sessionTokenUsage(sessionItemsFromUnknown(session.items));
			const billing = sessionBilling(session);
			return {
				role:
					session.id === input.rootId
						? "builder"
						: input.judgeIds?.has(session.id)
							? "judge"
							: session.agentRole === "checker"
								? "checker"
								: "subagent",
				model: modelLabel(session.listedModelId),
				agents: 1,
				requests: usage ? (usage.requests ?? null) : 0,
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				cacheReadTokens: usage?.cacheReadTokens ?? 0,
				costUsd: usageCostUsd(usage, billing),
				estimated: billing.kind === "plan",
			};
		}),
	);
}

/** One task attempt as the block reads it. */
export type EfficiencyRun = {
	readonly solved: boolean;
	/** Agent wall time. */
	readonly seconds: number;
	readonly models: readonly ModelSpendRow[];
};

export type EfficiencySummary = {
	readonly tasks: number;
	readonly solved: number;
	readonly totalUsd: number | null;
	readonly perTaskUsd: number | null;
	/** All spend (failures included) over solved tasks. */
	readonly perSolvedUsd: number | null;
	readonly tokensPerTask: number;
	readonly inputTokensPerTask: number;
	readonly outputTokensPerTask: number;
	/** Model calls per task; null when some run did not count them. */
	readonly callsPerTask: number | null;
	/** Cache reads over input tokens, 0..1; null without input. */
	readonly cacheHitRate: number | null;
	readonly secondsPerTask: number;
	readonly estimated: boolean;
	/** Per (role, model), summed over the runs. */
	readonly models: readonly (ModelSpendRow & {
		/** Share of the known dollars; null when dollars are unknown. */
		readonly costShare: number | null;
	})[];
};

export function efficiencySummary(
	runs: readonly EfficiencyRun[],
): EfficiencySummary {
	const tasks = runs.length;
	const solved = runs.filter((run) => run.solved).length;
	const merged = treeRowsMerge(runs.flatMap((run) => run.models));
	const sum = (pick: (row: ModelSpendRow) => number) =>
		merged.reduce((total, row) => total + pick(row), 0);
	const input = sum((row) => row.inputTokens);
	const output = sum((row) => row.outputTokens);
	const cache = sum((row) => row.cacheReadTokens);
	const totalUsd = merged.reduce<number | null>(
		(total, row) => plusNull(total, row.costUsd),
		0,
	);
	const calls = merged.reduce<number | null>(
		(total, row) => plusNull(total, row.requests),
		0,
	);
	const per = (value: number) => (tasks ? value / tasks : 0);
	return {
		tasks,
		solved,
		totalUsd: tasks ? totalUsd : null,
		perTaskUsd: totalUsd === null || !tasks ? null : totalUsd / tasks,
		perSolvedUsd: totalUsd === null || !solved ? null : totalUsd / solved,
		tokensPerTask: Math.round(per(input + output)),
		inputTokensPerTask: Math.round(per(input)),
		outputTokensPerTask: Math.round(per(output)),
		callsPerTask: calls === null || !tasks ? null : calls / tasks,
		cacheHitRate: input ? cache / input : null,
		secondsPerTask: per(runs.reduce((total, run) => total + run.seconds, 0)),
		estimated: merged.some((row) => row.estimated),
		models: merged.map((row) => ({
			...row,
			costShare:
				totalUsd && row.costUsd !== null ? row.costUsd / totalUsd : null,
		})),
	};
}

function treeRowsMerge(rows: readonly ModelSpendRow[]): ModelSpendRow[] {
	const merged = new Map<string, ModelSpendRow>();
	for (const row of rows) {
		const key = `${row.role}|${row.model}`;
		const previous = merged.get(key);
		merged.set(
			key,
			previous
				? {
						...previous,
						agents: previous.agents + row.agents,
						requests: plusNull(previous.requests, row.requests),
						inputTokens: previous.inputTokens + row.inputTokens,
						outputTokens: previous.outputTokens + row.outputTokens,
						cacheReadTokens: previous.cacheReadTokens + row.cacheReadTokens,
						costUsd: plusNull(previous.costUsd, row.costUsd),
						estimated: previous.estimated || row.estimated,
					}
				: row,
		);
	}
	return [...merged.values()].sort(
		(a, b) =>
			ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
			a.model.localeCompare(b.model),
	);
}

const k = (tokens: number) =>
	tokens >= 1_000_000
		? `${(tokens / 1_000_000).toFixed(2)}M`
		: `${Math.round(tokens / 1000)}k`;

/** The block's lines: a headline per run or arm, then one line per role and model. */
export function formatEfficiencyBlock(
	title: string,
	summary: EfficiencySummary,
): string[] {
	const tilde = summary.estimated ? "~" : "";
	const usd = (value: number | null) =>
		value === null
			? "$?"
			: `${tilde}$${value < 0.1 ? value.toFixed(4) : value.toFixed(3)}`;
	const lines = [
		`${title}: ${summary.solved}/${summary.tasks} solved · ${usd(summary.perTaskUsd)}/task · ${usd(summary.perSolvedUsd)}/solved · ${k(summary.tokensPerTask)} tok/task (in ${k(summary.inputTokensPerTask)}, out ${k(summary.outputTokensPerTask)}) · ${summary.callsPerTask === null ? "?" : summary.callsPerTask.toFixed(1)} calls/task · cache hit ${summary.cacheHitRate === null ? "-" : `${(summary.cacheHitRate * 100).toFixed(1)}%`} · ${Math.round(summary.secondsPerTask)} s/task${summary.estimated ? " (~$ = list-price estimate for plan-billed routes)" : ""}`,
	];
	for (const row of summary.models) {
		const cacheHit = row.inputTokens
			? ` · cache ${((row.cacheReadTokens / row.inputTokens) * 100).toFixed(0)}%`
			: "";
		lines.push(
			`  ${row.role.padEnd(8)} ${row.model.padEnd(28)} ${String(row.agents).padStart(3)} agent(s) · ${row.requests === null ? "?" : row.requests} calls · ${k(row.inputTokens + row.outputTokens)} tok${cacheHit} · ${usd(row.costUsd)}${row.costShare === null ? "" : ` (${Math.round(row.costShare * 100)}%)`}`,
		);
	}
	return lines;
}
