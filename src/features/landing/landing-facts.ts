/**
 * Terminal-Bench 4.0 numbers on the front page and in the launch post
 * (src/content/blog/harness-1-0.html, whose results table is the source of
 * truth; landing-facts.test.ts checks these against it). All runs used
 * GPT-6 Astra on all 66 tasks, five attempts each. The front page compares
 * with Codex at xhigh only; Codex at max appears in the chart and one note.
 * 58.5% vs 57.9% is a tie within noise: never present it as a win, and make
 * no speed claim.
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

export const BENCHMARK = {
	final: true,
	runUrl: HARBOR_JOBS.ours as string | null,
	setup:
		"Terminal-Bench 4.0 · GPT-6 Astra xhigh for both · all 66 tasks · 5 attempts each",
	tasks: 66,
	ours: { score: 58.5, solved: 49, cost: 7.47 },
	codex: { score: 57.9, solved: 46, cost: 7.12 },
	/** Codex at max effort: only in the chart and the cost note. */
	codexMax: { score: 58.2, solved: 47, cost: 9.9 },
};

/** Ours vs Codex max, cost per attempt, rounded to 5%: "about 25% lower". */
export const SAVING_VS_CODEX_MAX =
	Math.round((1 - BENCHMARK.ours.cost / BENCHMARK.codexMax.cost) * 20) * 5;

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
		cost: BENCHMARK.ours.cost,
		solved: BENCHMARK.ours.solved,
		href: HARBOR_JOBS.ours,
		ours: true,
	},
	{
		agent: "Codex",
		effort: "max",
		score: 58.18,
		cost: BENCHMARK.codexMax.cost,
		solved: BENCHMARK.codexMax.solved,
		href: HARBOR_JOBS.codexMax,
	},
	{
		agent: "Codex",
		effort: "xhigh",
		score: 57.88,
		cost: BENCHMARK.codex.cost,
		solved: BENCHMARK.codex.solved,
		href: HARBOR_JOBS.codexXhigh,
	},
];
