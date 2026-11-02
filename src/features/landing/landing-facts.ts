/**
 * Terminal-Bench 4.0 numbers on the front page and in the launch post
 * (src/content/blog/harness-1-0.html, whose results table is the source of
 * truth; landing-facts.test.ts checks the front-page table cell by cell
 * against it). All runs used GPT-6 Astra on all 66 tasks, five attempts
 * each. 58.5% vs 57.9% is a tie within noise: never present it as a win.
 * The time row is shown only with its footnote (ours is at OpenAI speed,
 * and the difference from Codex xhigh is within noise).
 */
export const HARBOR_JOBS = {
	ours: "https://hub.harborframework.com/jobs/6aacc762-8e07-4be2-ab4e-17495141235d",
	codexXhigh:
		"https://hub.harborframework.com/jobs/caf6e433-9fff-4475-b0bc-977f14ac7052",
	codexMax:
		"https://hub.harborframework.com/jobs/0f01715e-2f98-40e3-836f-1ac4fdce39a4",
} as const;

/** The launch post's address. */
export const HARNESS_POST_PATH = "/blog/harness-1-0";

/** One run: one column of the results table. Strings are the post's, verbatim. */
export type BenchRun = {
	agent: "ytimesy" | "Codex";
	effort: "xhigh" | "max";
	score: number;
	/** 95% interval of the score. */
	scoreCi: string;
	/** Paired per-task difference from ytimesy, in points; none for ytimesy. */
	vsOurs: { diff: string; ci: string } | null;
	solved: number;
	/** Cost per attempt in USD at OpenAI list prices. */
	cost: number;
	totalCost: string;
	inputTokens: string;
	outputTokens: string;
	time: string;
	job: string;
};

const OURS: BenchRun = {
	agent: "ytimesy",
	effort: "xhigh",
	score: 58.5,
	scoreCi: "47.9–68.8",
	vsOurs: null,
	solved: 49,
	cost: 7.47,
	totalCost: "$2,466",
	inputTokens: "3.34M",
	outputTokens: "48k",
	time: "33.2 min*",
	job: HARBOR_JOBS.ours,
};

const CODEX_MAX: BenchRun = {
	agent: "Codex",
	effort: "max",
	score: 58.2,
	scoreCi: "47.6–68.5",
	vsOurs: { diff: "−0.3", ci: "−6.1 to +4.8" },
	solved: 47,
	cost: 9.9,
	totalCost: "$3,267",
	inputTokens: "4.56M",
	outputTokens: "73k",
	time: "43.4 min",
	job: HARBOR_JOBS.codexMax,
};

const CODEX_XHIGH: BenchRun = {
	agent: "Codex",
	effort: "xhigh",
	score: 57.9,
	scoreCi: "47.3–68.2",
	vsOurs: { diff: "−0.6", ci: "−6.4 to +5.5" },
	solved: 46,
	cost: 7.12,
	totalCost: "$2,351",
	inputTokens: "3.60M",
	outputTokens: "45k",
	time: "33.3 min",
	job: HARBOR_JOBS.codexXhigh,
};

export const BENCHMARK = {
	final: true,
	runUrl: HARBOR_JOBS.ours as string | null,
	setup: "Terminal-Bench 4.0 · GPT-6 Astra · all 66 tasks · 5 attempts each",
	tasks: 66,
	/** The time row's footnote, the post's in one line. */
	timeNote:
		"* at OpenAI speed; the difference from Codex xhigh is within noise",
	ours: OURS,
	codexMax: CODEX_MAX,
	codex: CODEX_XHIGH,
};

/** The table's columns, in the post's order. */
export const BENCH_COLUMNS: readonly BenchRun[] = [
	OURS,
	CODEX_MAX,
	CODEX_XHIGH,
];

export type BenchCell = {
	value: string;
	/** The small line under the value (an interval). */
	ci?: string;
	href?: string;
};

export type BenchRow = {
	label: string;
	/** The small line under the label. */
	detail: string;
	cells: BenchCell[];
	/** The column with the best value, as the post underlines it; none when within noise. */
	best: number | null;
};

const money = (cost: number) => `$${cost.toFixed(2)}`;
const cells = (cell: (run: BenchRun) => BenchCell) => BENCH_COLUMNS.map(cell);

/** The front page's results table: the post's rows, cells and best values. */
export const BENCH_ROWS: readonly BenchRow[] = [
	{
		label: "Score",
		detail: "Average of 5 attempts, with 95% interval",
		cells: cells((run) => ({
			value: `${run.score.toFixed(1)}%`,
			ci: run.scoreCi,
		})),
		best: 0,
	},
	{
		label: "vs ytimesy",
		detail: "Paired per-task difference, in points",
		cells: cells((run) =>
			run.vsOurs
				? { value: run.vsOurs.diff, ci: run.vsOurs.ci }
				: { value: "—" },
		),
		best: null,
	},
	{
		label: "Tasks solved at least once",
		detail: "In any of the 5 attempts",
		cells: cells((run) => ({
			value: `${run.solved} of ${BENCHMARK.tasks}`,
		})),
		best: 0,
	},
	{
		label: "Cost per attempt",
		detail: "At OpenAI list prices",
		cells: cells((run) => ({ value: money(run.cost) })),
		best: 2,
	},
	{
		label: "Total cost",
		detail: "All 330 attempts",
		cells: cells((run) => ({ value: run.totalCost })),
		best: 2,
	},
	{
		label: "Input tokens per attempt",
		detail: "Read by the model",
		cells: cells((run) => ({ value: run.inputTokens })),
		best: 0,
	},
	{
		label: "Output tokens per attempt",
		detail: "Written by the model",
		cells: cells((run) => ({ value: run.outputTokens })),
		best: 2,
	},
	{
		label: "Time per attempt",
		detail: "Model and tool time",
		cells: cells((run) => ({ value: run.time })),
		best: null,
	},
	{
		label: "Harbor job",
		detail: "Public run on Harbor Hub",
		cells: cells((run) => ({
			value: run.job.slice(run.job.lastIndexOf("/") + 1).slice(0, 8),
			href: run.job,
		})),
		best: null,
	},
];

export type ScoreCostPoint = {
	agent: "ytimesy" | "Codex";
	effort: "xhigh" | "max";
	/** Unrounded score in percent, as the Harbor jobs report it. */
	score: number;
	/** Cost per attempt in USD at OpenAI list prices. */
	cost: number;
	solved: number;
	href: string;
	ours?: true;
};

/** The score-vs-cost chart's points (post and front page). */
export const SCORE_COST_POINTS: readonly ScoreCostPoint[] = [
	{
		agent: "ytimesy",
		effort: "xhigh",
		score: 58.48,
		cost: OURS.cost,
		solved: OURS.solved,
		href: HARBOR_JOBS.ours,
		ours: true,
	},
	{
		agent: "Codex",
		effort: "max",
		score: 58.18,
		cost: CODEX_MAX.cost,
		solved: CODEX_MAX.solved,
		href: HARBOR_JOBS.codexMax,
	},
	{
		agent: "Codex",
		effort: "xhigh",
		score: 57.88,
		cost: CODEX_XHIGH.cost,
		solved: CODEX_XHIGH.solved,
		href: HARBOR_JOBS.codexXhigh,
	},
];
