import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessPicker } from "./harness-picker";
import { ModelAttemptRows, MultipleModelsToggle } from "./model-attempt-menu";
import { sessionModelsFromListed } from "./model-capabilities";

describe("model picker trigger", () => {
	const props = {
		harnessId: "claude" as const,
		onHarnessIdChange: () => {},
		onModelIdChange: () => {},
		modelsEnabled: false,
	};
	it("shows the listed model even while disconnected", () => {
		const html = renderToStaticMarkup(
			createElement(HarnessPicker, {
				...props,
				models: sessionModelsFromListed([
					{ id: "test-model", label: "Listed model" },
				]),
				modelId: "test-model",
			}),
		);
		expect(html).toContain("<span>Listed model</span>");
	});
	it("names the first model and counts every extra run", () => {
		const html = renderToStaticMarkup(
			createElement(HarnessPicker, {
				...props,
				harnessId: "codex",
				modelsEnabled: true,
				models: sessionModelsFromListed([
					{ id: "grok", label: "Grok 4.7 High Fast" },
					{ id: "composer", label: "Composer 2.5 Fast" },
				]),
				modelId: "grok",
				multipleModels: true,
				attemptSlots: [
					{ modelId: "grok", count: 2 },
					{ modelId: "composer", count: 1 },
				],
				onMultipleModelsChange: () => {},
				onAttemptSlotsChange: () => {},
			}),
		);
		expect(html).toContain("Grok 4.7 High Fast");
		expect(html).toContain("+ 2");
		expect(html).not.toContain("Parallel attempts");
	});
	it("does not present a provider name as a selected model", () => {
		const html = renderToStaticMarkup(
			createElement(HarnessPicker, {
				...props,
				models: [],
				modelId: "",
			}),
		);
		expect(html).toContain("<span>Select model</span>");
		expect(html).not.toContain("<span>Claude</span>");
	});
	it("checks models and offers a copy count for the same task", () => {
		const html = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(MultipleModelsToggle, {
					checked: true,
					onCheckedChange: () => {},
				}),
				createElement(ModelAttemptRows, {
					harnessId: "codex",
					modelsEnabled: true,
					multiple: true,
					modelId: "grok",
					models: sessionModelsFromListed([
						{ id: "grok", label: "Grok 4.7 High Fast" },
						{ id: "composer", label: "Composer 2.5 Fast" },
					]),
					slots: [{ modelId: "grok", count: 2 }],
					favoriteIds: new Set<string>(),
					onChoose: () => {},
					onCountChange: () => {},
					onToggleFavorite: () => {},
				}),
			),
		);
		expect(html).toContain("Use Multiple Models");
		expect(html).toContain('role="checkbox"');
		expect(html).toContain('aria-checked="true"');
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain('aria-label="Grok 4.7 High Fast copies"');
		expect(html).toContain(">2x<");
		expect(html).toContain("Composer 2.5 Fast");
	});
});
