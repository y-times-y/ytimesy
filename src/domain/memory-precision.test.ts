import { describe, expect, it } from "vitest";
import { lineInScope, type MemoryProject } from "./memory-layout";
import {
	HYBRID_WEIGHTS,
	hybridScores,
	lexicalScores,
	memoryLineSearchText,
	memoryTokens,
} from "./memory-ranking";
import {
	cosineSimilarity,
	MEMORY_MATCH_POLICY,
	type MemoryLine,
	memoryLines,
	selectMemoryMatches,
} from "./memory-repo";

/**
 * An offline precision check for the read hook's selection: a memory with
 * two projects and personal notes, probes with the lines that are right for
 * them, and a deterministic stand-in for the embedding model (shared word
 * stems plus a constant background, so unrelated text still scores about
 * 0.2-0.3 as Qwen3-Embedding does). It compares the selection before this
 * change (every line, floor 0.36, top 8, file boost always) with the scoped
 * one (personal/ + the chat's project, floor 0.37 within 0.2 of the best,
 * at most 6, file boost only next to a strong hit). On it, 2026-11-01:
 * before 7/17 selected lines right, every right line found; after 7/7, every
 * right line found; scoped without the gap 7/8. The closest right line sits
 * 0.197 below its request's best ("Routes live under /api/v2"), so a gap
 * of 0.12 lost it. A proxy: the real
 * numbers come from `memory-two-chat-eval.ts --recall` and
 * `memory-long-history-eval.ts --recall-check` on dev.
 */

const WEB: MemoryProject = { fullName: "acme/web", repositoryIds: [1] };
const files = {
	"personal/style.md": [
		"- Prefers short replies without preamble",
		"- Writes commit messages in the imperative mood",
		"- Works on a Mac with zsh",
	].join("\n"),
	"projects/acme-web--1/tooling.md": [
		"- Install packages with pnpm, never npm",
		"- Run vitest for unit tests",
		"- Node is pinned to 22",
	].join("\n"),
	"projects/acme-web--1/api.md": [
		"- API errors return problem+json",
		"- Routes live under /api/v2",
		"- Timestamps are stored in UTC",
	].join("\n"),
	"projects/acme-web--1/deploy.md": [
		"- Deploy with wrangler to Cloudflare Workers",
		"- Never deploy on Fridays",
	].join("\n"),
	"projects/acme-api--2/tooling.md": [
		"- Install packages with yarn",
		"- Run pytest for unit tests",
		"- Python is pinned to 3.12",
	].join("\n"),
	"projects/acme-api--2/deploy.md": "- Deploy with fly to Fly.io",
	"projects/acme-api--2/api.md": [
		"- API errors return a JSON error envelope",
		"- Store timestamps as unix seconds",
	].join("\n"),
};

/** A web-project chat's requests and the lines that are right for each. */
const probes: { query: string; right: string[] }[] = [
	{
		query: "install the date-fns package",
		right: ["Install packages with pnpm, never npm"],
	},
	{
		query: "add a unit test for the price parser",
		right: ["Run vitest for unit tests"],
	},
	{
		query: "deploy the latest build",
		right: [
			"Deploy with wrangler to Cloudflare Workers",
			"Never deploy on Fridays",
		],
	},
	{
		query: "return an error from the orders route when items are missing",
		right: ["API errors return problem+json", "Routes live under /api/v2"],
	},
	{
		query: "store the created timestamp on each order",
		right: ["Timestamps are stored in UTC"],
	},
];

const BACKGROUND = 1.2;
/** Stems with a final e dropped, so route/routes and store/stored meet, as they would in an embedding. */
const stems = (text: string) =>
	memoryTokens(text).map((token) => token.replace(/e$/, ""));
function embed(text: string, vocabulary: readonly string[]) {
	const tokens = new Set(stems(text));
	return [
		BACKGROUND,
		...vocabulary.map((token) => (tokens.has(token) ? 1 : 0)),
	];
}

function run(policy: "before" | "after" | "no-gap") {
	const all = memoryLines(files);
	const lines =
		policy === "before" ? all : all.filter((entry) => lineInScope(entry, WEB));
	const vocabulary = [
		...new Set(
			[
				...all.map(memoryLineSearchText),
				...probes.map((probe) => probe.query),
			].flatMap(stems),
		),
	];
	let selected = 0;
	let right = 0;
	let found = 0;
	let wanted = 0;
	for (const probe of probes) {
		const query = embed(probe.query, vocabulary);
		const similarity = new Map<MemoryLine, number>(
			lines.map((entry) => [
				entry,
				cosineSimilarity(query, embed(memoryLineSearchText(entry), vocabulary)),
			]),
		);
		const scores = hybridScores(
			lines,
			similarity,
			lexicalScores(lines, probe.query),
			policy === "before" ? { ...HYBRID_WEIGHTS, strong: 0 } : HYBRID_WEIGHTS,
		);
		const picked = selectMemoryMatches({
			lines,
			scores,
			alreadyShown: () => false,
			today: "2026-11-01",
			query: probe.query,
			policy:
				policy === "before"
					? {
							limit: 8,
							minScore: 0.36,
							gap: Number.POSITIVE_INFINITY,
							alwaysProjectOnly: false,
						}
					: policy === "no-gap"
						? { ...MEMORY_MATCH_POLICY, gap: Number.POSITIVE_INFINITY }
						: MEMORY_MATCH_POLICY,
		}).map((entry) => entry.text);
		if (process.env.PRECISION_DEBUG)
			console.log(
				policy,
				probe.query,
				JSON.stringify(picked),
				JSON.stringify(
					[...scores]
						.sort((a, b) => b[1] - a[1])
						.slice(0, 6)
						.map(([entry, score]) => [
							entry.text.slice(0, 30),
							score.toFixed(3),
						]),
				),
			);
		selected += picked.length;
		right += picked.filter((text) => probe.right.includes(text)).length;
		found += probe.right.filter((text) => picked.includes(text)).length;
		wanted += probe.right.length;
	}
	return { precision: right / selected, recall: found / wanted, selected };
}

describe("read hook precision on the offline fixture", () => {
	it("keeps every right line and drops most of the wrong ones", () => {
		const before = run("before");
		const after = run("after");
		expect(after.recall).toBe(1);
		expect(after.recall).toBeGreaterThanOrEqual(before.recall);
		expect(after.selected).toBeLessThan(before.selected);
		expect(after.precision).toBeGreaterThan(before.precision + 0.2);
		// Scope alone is not all of it: the gap drops the near-floor tail.
		const noGap = run("no-gap");
		expect(noGap.recall).toBe(1);
		expect(after.precision).toBeGreaterThan(noGap.precision);
	});
});
