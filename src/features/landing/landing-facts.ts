/**
 * Terminal-Bench 4 numbers on the front page. Both agents ran GPT-6 Astra at
 * xhigh effort on the same 64 tasks; Codex's numbers are its public Harbor
 * Hub run. The page compares with Codex only. `final` stays false until all
 * five of our trials are in; `runUrl` links the run once it is public.
 */
export const BENCHMARK = {
	final: false,
	runUrl: null as string | null,
	setup:
		"Terminal-Bench 4 · ytimesy harness vs Codex · GPT-6 Astra xhigh for both · same 64 tasks",
	ours: { minutes: 19.3, score: 57.8, cost: 6.3 },
	codex: { minutes: 29.1, score: 57.2, cost: 6.52 },
};
