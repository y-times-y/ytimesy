import { describe, expect, it } from "vitest";
import { lineInScope } from "./memory-layout";
import {
	PRECISION_FILES,
	PRECISION_NEGATIVES,
	PRECISION_PROBES,
	PRECISION_PROJECT,
} from "./memory-precision-fixture";
import recorded from "./memory-precision-scores.json";
import {
	HYBRID_WEIGHTS,
	hybridScores,
	lexicalScores,
	memoryLineSearchText,
	memoryTokens,
} from "./memory-ranking";
import {
	cosineSimilarity,
	MEMORY_FALLBACK_POLICY,
	MEMORY_MATCH_POLICY,
	type MemoryLine,
	memoryLines,
	memoryRerankPool,
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

const WEB = PRECISION_PROJECT;
/**
 * The synthetic proxy keeps its 2026-11-01 memory and probes: the lines and
 * probes added for the reranker are checked with real scores below.
 */
const ADDED = new Set([
	"personal/customer-reporting.md",
	"personal/startup-lessons.md",
]);
const files = Object.fromEntries(
	Object.entries(PRECISION_FILES).filter(([path]) => !ADDED.has(path)),
);
const probes = PRECISION_PROBES.filter(
	(probe) =>
		probe.query !== "run the tests" &&
		probe.right.every((text) =>
			Object.values(files).some((content) => content.includes(text)),
		),
);

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
							rerankMinScore: 0,
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

/**
 * The same fixture replayed with real scores (Qwen3 hybrid and the
 * bge-reranker-base reranker), recorded by scripts/memory-rerank-calibrate.ts
 * --write on 2026-11-02: the calibration of MEMORY_RERANK_MIN_SCORE and
 * MEMORY_RERANK_FALLBACK_MIN_SCORE, checked offline.
 */
describe("read hook precision with recorded real scores", () => {
	const scores = recorded as Record<
		string,
		Record<string, { hybrid: number; rerank: number }>
	>;
	const inScope = memoryLines(PRECISION_FILES).filter((entry) =>
		lineInScope(entry, WEB),
	);
	/** The memory the two dev misfires came from: those personal lines and the project's. */
	const withoutStyle = inScope.filter(
		(entry) => entry.path !== "personal/style.md",
	);
	/** What the read hook selects: "rerank" scores the pool, "fallback" is the hybrid with the stricter floor. */
	function recall(
		query: string,
		mode: "rerank" | "fallback" | "before",
		lines = inScope,
	) {
		const recordedFor = scores[query];
		if (!recordedFor) throw new Error(`No recorded scores for "${query}".`);
		const score = (entry: MemoryLine, kind: "hybrid" | "rerank") => {
			const value = recordedFor[entry.text]?.[kind];
			if (value === undefined)
				throw new Error(`No recorded score for "${entry.text}".`);
			return value;
		};
		const match = {
			lines,
			scores: new Map(lines.map((entry) => [entry, score(entry, "hybrid")])),
			alreadyShown: () => false,
			today: "2026-11-02",
			query,
		};
		if (mode === "before")
			return selectMemoryMatches({ ...match, policy: MEMORY_MATCH_POLICY });
		if (mode === "fallback")
			return selectMemoryMatches({ ...match, policy: MEMORY_FALLBACK_POLICY });
		const pool = memoryRerankPool(match);
		return selectMemoryMatches({
			...match,
			rerank: new Map(pool.map((entry) => [entry, score(entry, "rerank")])),
		});
	}
	const texts = (lines: readonly MemoryLine[]) =>
		lines.map((entry) => entry.text);

	it("reproduces the dev misfires without the reranker", () => {
		expect(
			texts(recall("Reply with just the word OK.", "before", withoutStyle)),
		).toContain(PRECISION_FILES["personal/customer-reporting.md"].slice(2));
		expect(
			texts(recall(PRECISION_NEGATIVES[1], "before", withoutStyle)),
		).toContain(PRECISION_FILES["personal/startup-lessons.md"].slice(2));
	});

	it.each(["rerank", "fallback"] as const)(
		"keeps every right line (%s)",
		(mode) => {
			for (const probe of PRECISION_PROBES)
				expect(texts(recall(probe.query, mode))).toEqual(
					expect.arrayContaining(probe.right),
				);
		},
	);

	it.each(["rerank", "fallback"] as const)(
		"recalls nothing for messages nothing is relevant to (%s)",
		(mode) => {
			for (const query of PRECISION_NEGATIVES)
				expect([query, texts(recall(query, mode, withoutStyle))]).toEqual([
					query,
					[],
				]);
		},
	);

	it("lets through only a reply-style preference for messages about replies", () => {
		// The reranker ties "Prefers short replies" to "Reply with just the
		// word OK." (0.37): the one line no cutoff that keeps every right line drops.
		const kept = new Set(
			PRECISION_NEGATIVES.flatMap((query) => texts(recall(query, "rerank"))),
		);
		expect([...kept]).toEqual(["Prefers short replies without preamble"]);
	});

	it("drops most wrong lines on the requests", () => {
		const wrong = (mode: "rerank" | "before") =>
			PRECISION_PROBES.flatMap((probe) =>
				texts(recall(probe.query, mode)).filter(
					(text) => !probe.right.includes(text),
				),
			).length;
		expect(wrong("rerank")).toBeLessThanOrEqual(2);
		expect(wrong("before")).toBeGreaterThan(wrong("rerank"));
	});
});
