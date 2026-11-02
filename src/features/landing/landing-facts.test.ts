import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	BENCH_ROWS,
	BENCHMARK,
	HARBOR_JOBS,
	HARNESS_POST_PATH,
	SCORE_COST_POINTS,
} from "./landing-facts";

/** The launch post's results table is the source of truth. */
const post = readFileSync(
	new URL("../../content/blog/harness-1-0.html", import.meta.url),
	"utf8",
);

const text = (html: string) => html.replace(/<[^>]+>/g, "").trim();

/** The post's results-table rows: label, then each cell as the front page holds it. */
function postRows() {
	const table = post.match(/<table class="rt">([\s\S]*?)<\/table>/)?.[1];
	if (!table) throw new Error("no results table");
	return [...table.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map(
		([, label, body]) => {
			const tds = [...body.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
			const best = tds.findIndex((td) => td.includes('class="best"'));
			return {
				label,
				best: best === -1 ? null : best,
				cells: tds.map((td) => {
					const ci = td.match(/<span class="ci">(.*?)<\/span>/)?.[1];
					const href = td.match(/<a href="([^"]+)"/)?.[1];
					return {
						value: text(td.replace(/<span class="ci">.*?<\/span>/, "")),
						...(ci ? { ci } : {}),
						...(href ? { href } : {}),
					};
				}),
			};
		},
	);
}

it("the front-page table is the post's results table: rows, cells, intervals, links and best values", () => {
	const rows = postRows();
	expect(rows.map((row) => row.label)).toEqual([
		"Score",
		"vs ytimesy",
		"Tasks solved at least once",
		"Cost per attempt",
		"Total cost",
		"Input tokens per attempt",
		"Output tokens per attempt",
		"Time per attempt",
		"Harbor job",
	]);
	expect(
		BENCH_ROWS.map(({ label, cells, best }) => ({ label, cells, best })),
	).toEqual(rows);
});

it("the column headers, setup line and time footnote", () => {
	expect(post).toContain(
		'<th class="us">ytimesy<small>GPT-6 Astra xhigh</small></th><th>Codex<small>GPT-6 Astra max</small></th><th>Codex<small>GPT-6 Astra xhigh</small></th>',
	);
	expect(BENCHMARK.final).toBe(true);
	expect(BENCHMARK.setup).toBe(
		"Terminal-Bench 4.0 · GPT-6 Astra · all 66 tasks · 5 attempts each",
	);
	expect(BENCHMARK.timeNote).toBe(
		"* at OpenAI speed; the difference from Codex xhigh is within noise",
	);
	// The post's footnote says both things.
	expect(post).toContain("* Converted to OpenAI speed");
	expect(post).toContain(
		"The difference from Codex with GPT-6 Astra at xhigh is within noise, so no value in this row is underlined.",
	);
});

it("links the public Harbor jobs the post links", () => {
	expect(BENCHMARK.runUrl).toBe(HARBOR_JOBS.ours);
	for (const url of Object.values(HARBOR_JOBS)) expect(post).toContain(url);
	expect(HARNESS_POST_PATH).toBe("/blog/harness-1-0");
});

it("the chart's points round to the table's numbers", () => {
	const [ours, max, xhigh] = SCORE_COST_POINTS;
	expect([ours.agent, ours.effort, ours.score.toFixed(1)]).toEqual([
		"ytimesy",
		"xhigh",
		"58.5",
	]);
	expect([max.agent, max.effort, max.score.toFixed(1)]).toEqual([
		"Codex",
		"max",
		"58.2",
	]);
	expect([xhigh.agent, xhigh.effort, xhigh.score.toFixed(1)]).toEqual([
		"Codex",
		"xhigh",
		"57.9",
	]);
	expect(ours.href).toBe(HARBOR_JOBS.ours);
	expect(max.href).toBe(HARBOR_JOBS.codexMax);
	expect(xhigh.href).toBe(HARBOR_JOBS.codexXhigh);
});
