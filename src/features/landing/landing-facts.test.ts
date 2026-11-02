import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	BENCHMARK,
	HARBOR_JOBS,
	HARNESS_POST_PATH,
	SAVING_VS_CODEX_MAX,
	SCORE_COST_POINTS,
} from "./landing-facts";

/** The launch post's results table is the source of truth. */
const post = readFileSync(
	new URL("../../content/blog/harness-1-0.html", import.meta.url),
	"utf8",
);

/** A results-table row's cell texts: ytimesy, Codex max, Codex xhigh. */
function row(label: string): string[] {
	const match = post.match(
		new RegExp(`<th scope="row">${label}</th>(.*?)</tr>`),
	);
	if (!match) throw new Error(`no row ${label}`);
	return [...match[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) =>
		cell[1]
			.replace(/<span class="ci">.*?<\/span>/g, "")
			.replace(/<[^>]+>/g, "")
			.trim(),
	);
}

it("front-page numbers match the post's results table", () => {
	const { ours, codex, codexMax, tasks } = BENCHMARK;
	expect(row("Score")).toEqual([
		`${ours.score.toFixed(1)}%`,
		`${codexMax.score.toFixed(1)}%`,
		`${codex.score.toFixed(1)}%`,
	]);
	expect(row("Tasks solved at least once")).toEqual([
		`${ours.solved} of ${tasks}`,
		`${codexMax.solved} of ${tasks}`,
		`${codex.solved} of ${tasks}`,
	]);
	expect(row("Cost per attempt")).toEqual([
		`$${ours.cost.toFixed(2)}`,
		`$${codexMax.cost.toFixed(2)}`,
		`$${codex.cost.toFixed(2)}`,
	]);
	expect(BENCHMARK.final).toBe(true);
	expect(BENCHMARK.setup).toBe(
		"Terminal-Bench 4.0 · GPT-6 Astra xhigh for both · all 66 tasks · 5 attempts each",
	);
	expect(BENCHMARK).not.toHaveProperty("ours.minutes");
});

it("links the public Harbor jobs the post links", () => {
	expect(BENCHMARK.runUrl).toBe(HARBOR_JOBS.ours);
	for (const url of Object.values(HARBOR_JOBS)) expect(post).toContain(url);
	expect(post).toContain("6aacc762");
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

it("the cost note says 'about 25% lower' only because it is", () => {
	// $7.47 vs $9.90 is 24.5% lower.
	expect(1 - BENCHMARK.ours.cost / BENCHMARK.codexMax.cost).toBeCloseTo(
		0.245,
		3,
	);
	expect(SAVING_VS_CODEX_MAX).toBe(25);
});
