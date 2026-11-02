import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sessionModelsFromListed } from "./model-capabilities";
import { ModelPickerSettings } from "./model-picker-settings";

function settings(
	contextWindow:
		| { standard: number; alternate: number; note?: string }
		| undefined,
	alternateContext: boolean,
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
			alternateContext,
			onAlternateContextChange: () => {},
		}),
	);
}

describe("context window row", () => {
	it("shows the chosen window where the route offers a second one", () => {
		const option = {
			standard: 1_050_000,
			alternate: 272_000,
			note: "Stays under the 272K price tier",
		};
		const standard = settings(option, false);
		expect(standard).toContain("<span>Context</span>");
		expect(standard).toContain('aria-label="Context window"');
		expect(standard).toContain("1.05M");
		expect(settings(option, true)).toContain("272K");
	});
	it("shows no row for a model without a second window", () => {
		expect(settings(undefined, false)).not.toContain("Context");
	});
});
