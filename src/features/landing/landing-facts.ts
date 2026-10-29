/**
 * Terminal-Bench 4 numbers on the front page. Every agent ran GPT-6 Astra at
 * xhigh effort on the same 64 tasks; competitor runs are their public Harbor
 * Hub runs. `final` stays false until all five of our trials are in.
 */
export const BENCHMARK = {
	final: false,
	setup: "Terminal-Bench 4 · GPT-6 Astra xhigh for every agent · same 64 tasks",
	agents: [
		{ name: "ytimesy", minutes: 19.3, score: 57.8, ours: true },
		{ name: "Reason", minutes: 24.9, score: 58.3, ours: false },
		{ name: "Codex", minutes: 29.1, score: 57.2, ours: false },
	],
	costPerTask: { ours: 6.3, codex: 6.52 },
} as const;
