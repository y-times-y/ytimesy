import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLAUDE_PLAN_USAGE_HINT, ModelPickerPlanUsage } from "./plan-usage";

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
			'title="Updates after Claude is used">Claude plan</span>',
		);
		expect(html).toContain("<span>70% left</span>");
		expect(html).toContain("<span>10% left</span>");
		expect(html.match(/data-tone="low"/g)).toHaveLength(1);
		expect(html).not.toContain("ChatGPT");
	});
});
