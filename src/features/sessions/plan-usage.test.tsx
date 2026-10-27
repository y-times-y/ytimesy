import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPickerPlanUsage } from "./plan-usage";

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
		expect(html).toContain("<span>100%</span>");
		expect(html).toContain('title="Resets ');
		expect(html.match(/data-tone="low"/g)).toHaveLength(1);
	});

	it("renders nothing when the plan's usage is unknown", () => {
		expect(renderToStaticMarkup(<ModelPickerPlanUsage bars={[]} />)).toBe("");
	});
});
