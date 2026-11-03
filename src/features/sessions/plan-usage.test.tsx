import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { grokPlanUsageBars } from "#/domain/grok-plan-usage";
import { ClaudeCodeModels } from "./harness-picker";
import {
	CLAUDE_PLAN_USAGE_HINT,
	ModelPickerPlanUsage,
	SectionPlanUsage,
} from "./plan-usage";

describe("model picker plan usage", () => {
	it("shows the plan's windows as a labelled line, the reset in a tooltip", () => {
		const html = renderToStaticMarkup(
			<ModelPickerPlanUsage
				bars={[
					{ id: "primary", label: "5h", usedPercent: 100, resetsAt: 1 },
					{ id: "secondary", label: "Week", usedPercent: 20, resetsAt: null },
				]}
			/>,
		);
		expect(html).toContain('aria-label="ChatGPT plan usage"');
		expect(html).toContain(">ChatGPT plan</span>");
		expect(html).toContain("<span>0% left</span>");
		expect(html).toContain('title="Resets ');
		expect(html.match(/data-tone="low"/g)).toHaveLength(1);
	});

	it("renders nothing when the plan's usage is unknown", () => {
		expect(renderToStaticMarkup(<ModelPickerPlanUsage bars={[]} />)).toBe("");
	});

	it("shows the Claude plan's line with its update hint", () => {
		const html = renderToStaticMarkup(
			<ModelPickerPlanUsage
				bars={[
					{ id: "5h", label: "5h", usedPercent: 30, resetsAt: null },
					{ id: "7d", label: "Week", usedPercent: 90, resetsAt: null },
				]}
				label="Claude plan"
				hint={CLAUDE_PLAN_USAGE_HINT}
			/>,
		);
		expect(html).toContain('aria-label="Claude plan usage"');
		expect(html).toContain(
			'title="Reading it uses a tiny bit of your plan">Claude plan</span>',
		);
		expect(html).toContain("<span>70% left</span>");
		expect(html).toContain("<span>10% left</span>");
		expect(html.match(/data-tone="low"/g)).toHaveLength(1);
		expect(html).not.toContain("ChatGPT");
	});
});

describe("the Grok plan's line", () => {
	it("shows its weekly window from a reading, with the reset in a tooltip", () => {
		const html = renderToStaticMarkup(
			<SectionPlanUsage
				line={{
					bars: grokPlanUsageBars(
						{
							windows: [
								{
									id: "weekly",
									usedPercent: 10,
									resetsAt: Date.now() + 3_600_000,
								},
							],
							readAt: Date.now(),
						},
						Date.now(),
					),
					pending: false,
				}}
				label="Grok plan"
			/>,
		);
		expect(html).toContain('aria-label="Grok plan usage"');
		expect(html).toContain(">Week 90% left</span>");
		expect(html).toContain('title="90% left · Resets ');
		expect(html).not.toContain("data-low");
	});
});

describe("plan usage inside its picker section", () => {
	const bars = [
		{ id: "5h", label: "5h", usedPercent: 85, resetsAt: null },
		{ id: "7d", label: "Week", usedPercent: 10, resetsAt: null },
	];

	it("reads as short text in the heading row, low from 85% used", () => {
		const html = renderToStaticMarkup(
			<SectionPlanUsage line={{ bars, pending: false }} label="ChatGPT plan" />,
		);
		expect(html).toContain(
			'class="section-plan-usage" aria-label="ChatGPT plan usage"',
		);
		expect(html).toContain("5h 15% left");
		expect(html).not.toContain("model-picker-usage-bar");
		expect(html.match(/data-low/g)).toHaveLength(1);
	});

	it("shows a spent window as 0% left and low", () => {
		const html = renderToStaticMarkup(
			<SectionPlanUsage
				line={{
					bars: [{ id: "5h", label: "5h", usedPercent: 100, resetsAt: null }],
					pending: false,
				}}
				label="Claude plan"
			/>,
		);
		expect(html).toContain("5h 0% left");
		expect(html).toContain("data-low");
	});

	it("adds nothing while the first reading is on the way (the heading row holds its place)", () => {
		const html = renderToStaticMarkup(
			<SectionPlanUsage
				line={{ bars: [], pending: true }}
				label="Claude plan"
			/>,
		);
		expect(html).toBe("");
	});

	it("shows nothing when there is no reading", () => {
		expect(
			renderToStaticMarkup(
				<SectionPlanUsage
					line={{ bars: [], pending: false }}
					label="Claude plan"
				/>,
			),
		).toBe("");
	});

	it("puts the Claude plan's usage in the Claude Agent heading row, above the caption", () => {
		const html = renderToStaticMarkup(
			<ClaudeCodeModels
				models={[{ id: "claude-code:opus", label: "Opus" }]}
				usage={
					<SectionPlanUsage
						line={{ bars, pending: false }}
						label="Claude plan"
						hint={CLAUDE_PLAN_USAGE_HINT}
					/>
				}
				selectedRoute=""
				onSelect={() => {}}
			/>,
		);
		const heading = html.indexOf("Claude Agent</h3>");
		const line = html.indexOf('aria-label="Claude plan usage"');
		const caption = html.indexOf("Claude subscription</p>");
		expect(heading).toBeGreaterThan(-1);
		expect(line).toBeGreaterThan(heading);
		expect(caption).toBeGreaterThan(line);
		expect(html).toContain('class="model-section-head"');
	});
});
