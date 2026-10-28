import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPickerUsage } from "./usage-windows";

describe("model picker cloud usage", () => {
	it("shows each window as one compact bar", () => {
		const html = renderToStaticMarkup(
			<ModelPickerUsage
				windows={[
					{
						id: "five_hour",
						limitMicroUsd: 100,
						usedMicroUsd: 12,
						usedPercent: 12,
						exhausted: false,
						resetsAt: null,
					},
					{
						id: "weekly",
						limitMicroUsd: 100,
						usedMicroUsd: 90,
						usedPercent: 90,
						exhausted: false,
						resetsAt: null,
					},
				]}
			/>,
		);
		expect(html).toContain('aria-label="Cloud usage"');
		expect(html).toContain(">Cloud</span>");
		expect(html).toContain("<span>5h</span>");
		expect(html).toContain("<span>88% left</span>");
		expect(html).toContain('data-tone="low"');
	});

	it("renders nothing where usage is not metered", () => {
		expect(renderToStaticMarkup(<ModelPickerUsage windows={[]} />)).toBe("");
		expect(renderToStaticMarkup(<ModelPickerUsage windows={undefined} />)).toBe(
			"",
		);
	});
});
