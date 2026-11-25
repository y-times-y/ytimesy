import type { ApiTokenUsage } from "./api-token-usage";
import type { SessionItem } from "./session-item";
import type { DayTokens, UsageProvider } from "./usage-heatmap";

/** Where a turn ran: a turn runner box, a Durable Object, or a project's Y² chat. */
export type UsageSource = "box" | "durable-object" | "y2";

/** One day of one user's usage for one provider, model, project and source. */
export type UsageDailyRow = {
	/** UTC calendar day, YYYY-MM-DD. */
	readonly day: string;
	readonly provider: UsageProvider;
	readonly modelId: string;
	readonly projectId: string | null;
	readonly projectName: string | null;
	readonly source: UsageSource;
	readonly turns: number;
	/** Turns that reported no token counts (subscription runtimes); their tokens are unknown, not zero. */
	readonly unknownTurns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
};

export type TurnUsageFact = {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	/** False when the turn recorded no usable counts. */
	readonly known: boolean;
};

/** The turn's usage: the last user message carries it (applyApiProgress). */
export function turnUsageFact(items: readonly SessionItem[]): TurnUsageFact {
	let usage: ApiTokenUsage | undefined;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item?.kind === "userMessage") {
			usage = item.apiUsage;
			break;
		}
	}
	const known =
		!!usage && usage.inputTokens !== null && usage.outputTokens !== null;
	return {
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		known,
	};
}

/** The provider whose model ran, from the model id; the connection's provider decides only when the id says nothing. */
export function usageProvider(
	modelId: string,
	connectionProvider?: string | null,
): UsageProvider {
	const id = modelId
		.toLowerCase()
		.replace(/^[^/]+\//, (family) => (family === "x-ai/" ? "grok-" : family));
	if (/claude|anthropic/.test(id) || id.startsWith("anthropic/"))
		return "anthropic";
	if (/^grok|x-ai|xai/.test(id)) return "xai";
	if (/gemini|gemma|^google\//.test(id)) return "google";
	if (/^(gpt|o\d|codex|chatgpt)|^openai\//.test(id)) return "openai";
	if (connectionProvider === "anthropic") return "anthropic";
	if (connectionProvider === "google") return "google";
	if (connectionProvider === "openai") return "openai";
	return "other";
}

export type UsageRange = "7d" | "30d" | "90d" | "all";
export const USAGE_RANGES: readonly { id: UsageRange; label: string }[] = [
	{ id: "7d", label: "7 days" },
	{ id: "30d", label: "30 days" },
	{ id: "90d", label: "90 days" },
	{ id: "all", label: "All time" },
];
const RANGE_DAYS: Record<Exclude<UsageRange, "all">, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
};

export type UsageTotals = {
	readonly turns: number;
	readonly unknownTurns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	/** Input plus output; cached tokens are part of the input. */
	readonly totalTokens: number;
};

const EMPTY_TOTALS: UsageTotals = {
	turns: 0,
	unknownTurns: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	totalTokens: 0,
};

function add(total: UsageTotals, row: UsageDailyRow): UsageTotals {
	return {
		turns: total.turns + row.turns,
		unknownTurns: total.unknownTurns + row.unknownTurns,
		inputTokens: total.inputTokens + row.inputTokens,
		outputTokens: total.outputTokens + row.outputTokens,
		cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
		totalTokens: total.totalTokens + row.inputTokens + row.outputTokens,
	};
}

export const sumUsage = (rows: readonly UsageDailyRow[]) =>
	rows.reduce(add, EMPTY_TOTALS);

const DAY_MS = 86_400_000;
const dayNumber = (day: string) =>
	Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
export const dayString = (number: number) =>
	new Date(number * DAY_MS).toISOString().slice(0, 10);

export type Breakdown = readonly {
	readonly key: string;
	readonly label: string;
	readonly totals: UsageTotals;
	/** Share of the range's known tokens, 0 to 1. */
	readonly share: number;
}[];

function breakdown(
	rows: readonly UsageDailyRow[],
	keyOf: (row: UsageDailyRow) => { key: string; label: string },
): Breakdown {
	const groups = new Map<string, { label: string; totals: UsageTotals }>();
	for (const row of rows) {
		const { key, label } = keyOf(row);
		const group = groups.get(key) ?? { label, totals: EMPTY_TOTALS };
		groups.set(key, { label, totals: add(group.totals, row) });
	}
	const all = [...groups.entries()];
	const sum = all.reduce((n, [, g]) => n + g.totals.totalTokens, 0);
	return all
		.map(([key, g]) => ({
			key,
			label: g.label,
			totals: g.totals,
			share: sum > 0 ? g.totals.totalTokens / sum : 0,
		}))
		.sort(
			(a, b) =>
				b.totals.totalTokens - a.totals.totalTokens ||
				a.label.localeCompare(b.label),
		);
}

export type UsageSummary = {
	readonly range: UsageRange;
	readonly current: UsageTotals;
	/** The same length of time just before; null for all time. */
	readonly previous: UsageTotals | null;
	/** Change against the previous period; null when it has no tokens to compare. */
	readonly changeShare: number | null;
	readonly byProvider: Breakdown;
	readonly byModel: Breakdown;
	readonly byProject: Breakdown;
	readonly bySource: Breakdown;
};

/** Rows within [from, to] days (inclusive) of today, UTC. */
function within(rows: readonly UsageDailyRow[], from: number, to: number) {
	return rows.filter((row) => {
		const n = dayNumber(row.day);
		return n >= from && n <= to;
	});
}

export function summarizeUsage(
	rows: readonly UsageDailyRow[],
	range: UsageRange,
	today: string,
): UsageSummary {
	const end = dayNumber(today);
	const length = range === "all" ? null : RANGE_DAYS[range];
	const start = length === null ? Number.NEGATIVE_INFINITY : end - length + 1;
	const current = within(rows, start, end);
	const previous =
		length === null ? null : within(rows, start - length, start - 1);
	const currentTotals = sumUsage(current);
	const previousTotals = previous ? sumUsage(previous) : null;
	return {
		range,
		current: currentTotals,
		previous: previousTotals,
		changeShare:
			previousTotals && previousTotals.totalTokens > 0
				? (currentTotals.totalTokens - previousTotals.totalTokens) /
					previousTotals.totalTokens
				: null,
		byProvider: breakdown(current, (r) => ({
			key: r.provider,
			label: r.provider,
		})),
		byModel: breakdown(current, (r) => ({ key: r.modelId, label: r.modelId })),
		byProject: breakdown(current, (r) => ({
			key: r.projectId ?? "none",
			label: r.projectName ?? "No project",
		})),
		bySource: breakdown(current, (r) => ({ key: r.source, label: r.source })),
	};
}

export type HeatmapDay = DayTokens & { turns: number };

/** Per-day provider tokens and turns, for the heatmap. */
export function heatmapDays(
	rows: readonly UsageDailyRow[],
): Map<string, { tokens: DayTokens; turns: number; unknownTurns: number }> {
	const days = new Map<
		string,
		{ tokens: DayTokens; turns: number; unknownTurns: number }
	>();
	for (const row of rows) {
		const day = days.get(row.day) ?? { tokens: {}, turns: 0, unknownTurns: 0 };
		day.tokens[row.provider] =
			(day.tokens[row.provider] ?? 0) + row.inputTokens + row.outputTokens;
		day.turns += row.turns;
		day.unknownTurns += row.unknownTurns;
		days.set(row.day, day);
	}
	return days;
}
