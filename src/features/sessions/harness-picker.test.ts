import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessPicker } from "./harness-picker";
import { sessionModelsFromListed } from "./model-capabilities";

/** The picker reads cloud usage with react-query. */
function picker(props: ComponentProps<typeof HarnessPicker>) {
	return createElement(
		QueryClientProvider,
		{ client: new QueryClient() },
		createElement(HarnessPicker, props),
	);
}

describe("model picker trigger", () => {
	const props = {
		harnessId: "codex" as const,
		onHarnessIdChange: () => {},
		onModelIdChange: () => {},
		modelsEnabled: false,
	};
	it("shows the listed model even while disconnected", () => {
		const html = renderToStaticMarkup(
			picker({
				...props,
				models: sessionModelsFromListed([
					{ id: "test-model", label: "Listed model" },
				]),
				modelId: "test-model",
			}),
		);
		expect(html).toContain("<span>Listed model</span>");
	});
	it("does not present a provider name as a selected model", () => {
		const html = renderToStaticMarkup(
			picker({
				...props,
				models: [],
				modelId: "",
			}),
		);
		expect(html).toContain("<span>Select model</span>");
		expect(html).not.toContain("<span>Codex</span>");
	});
});
