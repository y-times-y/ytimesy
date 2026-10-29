/**
 * Terminal-Bench 4 numbers on the front page. Both agents ran GPT-6 Astra at
 * xhigh effort on the same 64 tasks; Codex's numbers are its public Harbor
 * Hub run. The page compares with Codex only. `final` stays false until all five of our trials are in.
 */
export const BENCHMARK = {
	final: false,
	setup: "Terminal-Bench 4 · GPT-6 Astra xhigh for both · same 64 tasks",
	agents: [
		{ name: "ytimesy", minutes: 19.3, score: 57.8, ours: true },
		{ name: "Codex", minutes: 29.1, score: 57.2, ours: false },
	],
	costPerTask: { ours: 6.3, codex: 6.52 },
} as const;
