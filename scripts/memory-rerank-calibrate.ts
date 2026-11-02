// Calibrates the read hook's hybrid floor (MEMORY_MATCH_MIN_SCORE) and the
// reranker's cutoff (MEMORY_RERANK_MIN_SCORE, off by MEMORY_RERANK_ON).
// Development only.
//
//   CLOUDFLARE_API_TOKEN=$(npx wrangler auth token) node --import tsx scripts/memory-rerank-calibrate.ts
//       Scores every probe of the offline precision fixture (positive and
//       must-recall-nothing) and the two-chat eval's --recall probes against
//       their memory lines with the real Qwen3 embeddings (the hybrid score)
//       and the real reranker, then prints where right and wrong lines score,
//       a cutoff sweep, and what the current constants select.
//       CLOUDFLARE_ACCOUNT_ID defaults to scripts/development-config.ts.
//   ... memory-rerank-calibrate.ts --write
//       Also records the fixture's scores in
//       src/domain/memory-precision-scores.json, which memory-precision.test.ts
//       replays offline.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { lineInScope } from "../src/domain/memory-layout";
import {
	PRECISION_FILES,
	PRECISION_NEGATIVES,
	PRECISION_PROBES,
	PRECISION_PROJECT,
} from "../src/domain/memory-precision-fixture";
import { memoryMatchScores } from "../src/domain/memory-ranking";
import {
	cosineSimilarity,
	MEMORY_MATCH_POLICY,
	MEMORY_RERANK_MIN_SCORE,
	MEMORY_RERANK_POLICY,
	type MemoryLine,
	memoryLineEmbeddingText,
	memoryLines,
	memoryRerankPool,
	memoryRerankText,
	memoryToday,
	selectMemoryMatches,
} from "../src/domain/memory-repo";
import { CLOUDFLARE_ACCOUNT_ID } from "./development-config";
import {
	DISTRACTOR_LINES,
	RECALL_PROBES,
	RULE_FILES,
	SCENARIOS,
} from "./memory-eval/scenarios";

const { values: flags } = parseArgs({
	options: { write: { type: "boolean", default: false } },
});

const SCORES_FILE = "src/domain/memory-precision-scores.json";

type Probe = {
	set: "fixture" | "two-chat";
	query: string;
	/** Texts of the right lines; empty for a must-recall-nothing message. */
	right: string[];
	negative: boolean;
};
type Scored = {
	probe: Probe;
	lines: MemoryLine[];
	hybrid: Map<MemoryLine, number>;
	rerank: Map<MemoryLine, number>;
	ms: number;
};

function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
		)
		.join("\n");
}

const fmt = (value: number) =>
	value >= 0.01 ? value.toFixed(3) : value.toExponential(1);

async function main() {
	process.env.CLOUDFLARE_ACCOUNT_ID ||= CLOUDFLARE_ACCOUNT_ID;
	const { memoryEmbedder, memoryReranker } = await import(
		"../src/server/adapters/memory-embeddings"
	);
	const embed = memoryEmbedder();
	const rerank = memoryReranker();
	if (!embed || !rerank)
		throw new Error(
			"Set CLOUDFLARE_API_TOKEN (npx wrangler auth token); CLOUDFLARE_ACCOUNT_ID is optional.",
		);
	const fixtureLines = memoryLines(PRECISION_FILES).filter((entry) =>
		lineInScope(entry, PRECISION_PROJECT),
	);
	const twoChatLines = [
		...SCENARIOS.map((scenario) => ({
			id: scenario.id,
			path: RULE_FILES[scenario.id],
			text: scenario.rule,
		})),
		...DISTRACTOR_LINES.map((line) => ({ id: "distractor", ...line })),
	].map(
		(line, index): MemoryLine => ({
			path: line.path,
			text: line.text,
			line: index + 1,
			raw: `- ${line.text}`,
			meta: { scenario: line.id },
		}),
	);
	const probes: [Probe, MemoryLine[]][] = [
		...PRECISION_PROBES.map((probe): [Probe, MemoryLine[]] => [
			{
				set: "fixture",
				query: probe.query,
				right: probe.right,
				negative: false,
			},
			fixtureLines,
		]),
		...PRECISION_NEGATIVES.map((query): [Probe, MemoryLine[]] => [
			{ set: "fixture", query, right: [], negative: true },
			fixtureLines,
		]),
		...RECALL_PROBES.map((probe): [Probe, MemoryLine[]] => [
			{
				set: "two-chat",
				query: probe.query,
				right: twoChatLines
					.filter((line) => line.meta.scenario === probe.scenario)
					.map((line) => line.text),
				negative: false,
			},
			twoChatLines,
		]),
	];
	const vectors = new Map<MemoryLine[], number[][]>();
	for (const lines of [fixtureLines, twoChatLines])
		vectors.set(
			lines,
			await embed.documents(lines.map(memoryLineEmbeddingText)),
		);
	const scored: Scored[] = [];
	for (const [probe, lines] of probes) {
		const query = await embed.query(probe.query);
		const lineVectors = vectors.get(lines) ?? [];
		const similarity = new Map(
			lines.map((entry, index) => [
				entry,
				cosineSimilarity(query, lineVectors[index] ?? []),
			]),
		);
		const hybrid = memoryMatchScores(lines, similarity, probe.query);
		// Every line, not just the pool, so the sweep sees the whole picture.
		const started = Date.now();
		const scores = await rerank(probe.query, lines.map(memoryRerankText));
		const ms = Date.now() - started;
		scored.push({
			probe,
			lines,
			hybrid,
			rerank: new Map(lines.map((entry, index) => [entry, scores[index]])),
			ms,
		});
	}

	const today = memoryToday();
	/** "old": the 2026-11-01 floor (0.37); "hybrid": MEMORY_MATCH_POLICY; "rerank": the reranker on. */
	const select = (item: Scored, mode: "old" | "hybrid" | "rerank") => {
		const match = {
			lines: item.lines,
			scores: item.hybrid,
			alreadyShown: () => false,
			today,
			query: item.probe.query,
		};
		if (mode === "old")
			return selectMemoryMatches({ ...match, policy: MEMORY_RERANK_POLICY });
		if (mode === "hybrid")
			return selectMemoryMatches({ ...match, policy: MEMORY_MATCH_POLICY });
		const pool = memoryRerankPool({ ...match, policy: MEMORY_RERANK_POLICY });
		return selectMemoryMatches({
			...match,
			policy: MEMORY_RERANK_POLICY,
			rerank: new Map(
				pool.map((entry) => [entry, item.rerank.get(entry) ?? 0]),
			),
		});
	};

	const rows = [
		[
			"set",
			"probe",
			"right line (hybrid / rerank)",
			"best wrong in pool (rerank)",
			"selected now",
		],
	];
	for (const item of scored) {
		const pool = memoryRerankPool({
			lines: item.lines,
			scores: item.hybrid,
			alreadyShown: () => false,
			today,
			policy: MEMORY_RERANK_POLICY,
		});
		const right = item.lines.filter((entry) =>
			item.probe.right.includes(entry.text),
		);
		const wrong = pool
			.filter((entry) => !item.probe.right.includes(entry.text))
			.sort((a, b) => (item.rerank.get(b) ?? 0) - (item.rerank.get(a) ?? 0))[0];
		const picked = select(item, "rerank");
		rows.push([
			item.probe.negative ? "negative" : item.probe.set,
			item.probe.query.slice(0, 48),
			right
				.map(
					(entry) =>
						`${entry.text.slice(0, 24)} ${fmt(item.hybrid.get(entry) ?? 0)}/${fmt(item.rerank.get(entry) ?? 0)}`,
				)
				.join("; ") || "-",
			wrong
				? `${wrong.text.slice(0, 24)} ${fmt(item.rerank.get(wrong) ?? 0)}`
				: "-",
			picked
				.map(
					(entry) =>
						`${item.probe.right.includes(entry.text) ? "+" : "x"}${entry.text.slice(0, 18)}`,
				)
				.join(", ") || "(nothing)",
		]);
	}
	console.log(table(rows));

	// The reranker cutoff: right lines vs wrong lines the hybrid lets into the pool.
	const inPool = (item: Scored) =>
		new Set(
			memoryRerankPool({
				lines: item.lines,
				scores: item.hybrid,
				alreadyShown: () => false,
				today,
				policy: MEMORY_RERANK_POLICY,
			}),
		);
	const rightScores = (set: Probe["set"]) =>
		scored
			.filter((item) => item.probe.set === set && !item.probe.negative)
			.flatMap((item) =>
				item.lines
					.filter((entry) => item.probe.right.includes(entry.text))
					.map((entry) => ({
						score: item.rerank.get(entry) ?? 0,
						pooled: inPool(item).has(entry),
						text: `${item.probe.query.slice(0, 30)} -> ${entry.text.slice(0, 30)}`,
					})),
			);
	const negativeScores = scored
		.filter((item) => item.probe.negative)
		.flatMap((item) => {
			const pool = inPool(item);
			return item.lines
				.filter((entry) => pool.has(entry))
				.map((entry) => ({
					score: item.rerank.get(entry) ?? 0,
					text: `${item.probe.query.slice(0, 30)} -> ${entry.text.slice(0, 30)}`,
				}));
		});
	const fixtureRight = rightScores("fixture");
	const lowest = [...fixtureRight].sort((a, b) => a.score - b.score)[0];
	const highest = [...negativeScores].sort((a, b) => b.score - a.score);
	console.log(
		`\nFixture right lines, reranker: lowest ${lowest ? `${fmt(lowest.score)} (${lowest.text})` : "-"}`,
	);
	console.log("Must-recall-nothing messages, highest pooled lines (reranker):");
	for (const row of highest.slice(0, 6))
		console.log(`  ${fmt(row.score)}  ${row.text}`);
	const sweep = [
		[
			"cutoff",
			"fixture right kept",
			"two-chat right kept",
			"negative lines kept",
		],
	];
	for (const cutoff of [
		1e-4, 3e-4, 5e-4, 7e-4, 8.5e-4, 1e-3, 2e-3, 5e-3, 1e-2,
	]) {
		const kept = (rows: { score: number; pooled?: boolean }[]) =>
			rows.filter((row) => row.pooled !== false && row.score >= cutoff).length;
		const twoChat = rightScores("two-chat");
		sweep.push([
			fmt(cutoff),
			`${kept(fixtureRight)}/${fixtureRight.length}`,
			`${kept(twoChat)}/${twoChat.length}`,
			String(kept(negativeScores)),
		]);
	}
	console.log(`\n${table(sweep)}`);

	// The hybrid floor alone.
	const fallbackRight = scored
		.filter((item) => item.probe.set === "fixture" && !item.probe.negative)
		.flatMap((item) =>
			item.lines
				.filter((entry) => item.probe.right.includes(entry.text))
				.map((entry) => item.hybrid.get(entry) ?? 0),
		);
	const fallbackNegative = scored
		.filter((item) => item.probe.negative)
		.map((item) => {
			const [line, score] = [...item.hybrid].sort((a, b) => b[1] - a[1])[0];
			return {
				score,
				text: `${item.probe.query.slice(0, 30)} -> ${line.text.slice(0, 30)}`,
			};
		})
		.sort((a, b) => b.score - a.score);
	console.log(
		`\nHybrid: lowest fixture right line ${fmt(Math.min(...fallbackRight))}; best line per must-recall-nothing message:`,
	);
	for (const row of fallbackNegative)
		console.log(`  ${fmt(row.score)}  ${row.text}`);

	const count = (mode: "old" | "hybrid" | "rerank") => {
		let right = 0;
		let wanted = 0;
		let wrong = 0;
		let negative = 0;
		let twoChat = 0;
		for (const item of scored) {
			const picked = select(item, mode);
			if (item.probe.negative) negative += picked.length;
			else if (item.probe.set === "two-chat")
				twoChat += item.probe.right.some((text) =>
					picked.some((entry) => entry.text === text),
				)
					? 1
					: 0;
			else {
				wanted += item.probe.right.length;
				right += picked.filter((entry) =>
					item.probe.right.includes(entry.text),
				).length;
				wrong += picked.filter(
					(entry) => !item.probe.right.includes(entry.text),
				).length;
			}
		}
		return `fixture right ${right}/${wanted}, wrong ${wrong}; negative lines ${negative}; two-chat rules ${twoChat}/${RECALL_PROBES.length}`;
	};
	console.log(
		`\nFloor ${MEMORY_RERANK_POLICY.minScore}, gap ${MEMORY_MATCH_POLICY.gap}: ${count("old")}`,
	);
	console.log(
		`Floor ${MEMORY_MATCH_POLICY.minScore} (the default): ${count("hybrid")}`,
	);
	console.log(
		`Reranker (cutoff ${MEMORY_RERANK_MIN_SCORE}, pool at ${MEMORY_RERANK_POLICY.minScore}): ${count("rerank")}`,
	);
	const times = scored.map((item) => item.ms).sort((a, b) => a - b);
	console.log(
		`Reranker REST latency over ${times.length} calls (${fixtureLines.length}-${twoChatLines.length} lines each): median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms`,
	);

	if (flags.write) {
		const record: Record<
			string,
			Record<string, { hybrid: number; rerank: number }>
		> = {};
		for (const item of scored.filter((entry) => entry.probe.set === "fixture"))
			record[item.probe.query] = Object.fromEntries(
				item.lines.map((entry) => [
					entry.text,
					{
						hybrid: Number((item.hybrid.get(entry) ?? 0).toFixed(5)),
						rerank: Number((item.rerank.get(entry) ?? 0).toPrecision(4)),
					},
				]),
			);
		await writeFile(SCORES_FILE, `${JSON.stringify(record, null, "\t")}\n`);
		console.log(`Wrote ${SCORES_FILE}`);
	}
}

await main();
