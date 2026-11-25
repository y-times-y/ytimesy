import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageReportView } from "./usage-report";

const row = (over: object) => ({
	day: "2026-11-24",
	provider: "anthropic",
	modelId: "claude-sonnet-5-5",
	projectId: "p",
	projectName: "acme/app",
	source: "box",
	turns: 2,
	unknownTurns: 0,
	inputTokens: 1000,
	outputTokens: 200,
	cacheReadTokens: 300,
	...over,
});
const rows = [
	row({}),
	row({ provider: "openai", modelId: "gpt-5.5", inputTokens: 5000, turns: 3 }),
	row({ day: "2026-11-20", unknownTurns: 1 }),
] as never;
const html = renderToStaticMarkup(
	<UsageReportView rows={rows} today="2026-11-25" />,
);

describe("UsageReportView", () => {
	it("shows totals, the range switch and every breakdown, with no stray text", () => {
		expect(html).toContain("tokens spent");
		expect(html).toMatch(/aria-pressed="true"[^>]*>30 days/);
		for (const name of [
			"By provider",
			"By model",
			"By project",
			"By where it ran",
		])
			expect(html).toContain(`aria-label="${name}"`);
		expect(html).not.toMatch(/biome|would add/);
		expect(html).toContain("no token counts");
		expect(html).toContain("separate meters");
		expect(html).toContain("Days are UTC");
	});

	it("labels every day cell with its date, split and turns, and gives the grid one tab stop", () => {
		expect(html.match(/role="gridcell"/g)?.length).toBeGreaterThan(360);
		expect(html.match(/tabindex="0"/g)).toHaveLength(1);
		const label =
			html.match(/aria-label="([^"]*Nov 24, 2026[^"]*)"/)?.[1] ?? "";
		expect(label).toMatch(/OpenAI \/ Codex 5\.2K/);
		expect(label).toMatch(/Anthropic 1\.2K/);
		expect(label).toContain("5 turns");
		expect(html).toMatch(/aria-label="[^"]*Nov 1, 2026: no usage"/);
	});

	it("colours each day by its dominant provider, with one step legend", () => {
		expect(html).toMatch(/data-level="4" data-provider="openai"/);
		expect(html).toContain("steps at");
		expect(html.match(/usage-heatmap-swatch/g)).toHaveLength(5);
	});
});
