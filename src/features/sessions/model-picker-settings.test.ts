import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sessionModelsFromListed } from "./model-capabilities";
import { ModelPickerSettings } from "./model-picker-settings";

function settings(
	contextWindow:
		| { standard: number; large: number; costNote?: string }
		| undefined,
	largeContext: boolean,
) {
	const [model] = sessionModelsFromListed([
		{
			id: "m",
			label: "Model",
			...(contextWindow ? { contextWindow } : {}),
		},
	]);
	return renderToStaticMarkup(
		createElement(ModelPickerSettings, {
			model: model as NonNullable<typeof model>,
			reasoningId: "",
			speed: "",
			largeContext,
			onLargeContextChange: () => {},
		}),
	);
}

describe("context window row", () => {
	it("shows the chosen window where the route offers a larger one", () => {
		const option = {
			standard: 272_000,
			large: 1_050_000,
			costNote: "Past 272K: 2× input, 1.5× output price",
		};
		const standard = settings(option, false);
		expect(standard).toContain("<span>Context</span>");
		expect(standard).toContain('aria-label="Context window"');
		expect(standard).toContain("272K");
		expect(settings(option, true)).toContain("1.05M");
	});
	it("shows no row for a model without a larger window", () => {
		expect(settings(undefined, false)).not.toContain("Context");
	});
});
