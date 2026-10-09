import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProviderConfirmation } from "./provider-confirmation";

it("opens the provider-owned confirmation without pretending access is verified", () => {
	const html = renderToStaticMarkup(
		createElement(ProviderConfirmation, {
			author: "meta",
			connectionProvider: "openrouter",
		}),
	);
	expect(html).toContain("Confirm 18+");
	expect(html).toContain('href="https://openrouter.ai/settings/preferences"');
	expect(html).toContain('target="_blank"');
	expect(html).toContain('rel="noopener noreferrer"');
	expect(html).not.toContain("aria-checked");
	expect(html).not.toContain("verified");
});

it.each([
	["meta", "compatible"],
	["google", "openrouter"],
	[null, "openrouter"],
	["meta", undefined],
])("does not impose gateway confirmation on %s / %s", (author, provider) => {
	expect(
		renderToStaticMarkup(
			createElement(ProviderConfirmation, {
				author: author ?? null,
				connectionProvider: provider ?? undefined,
			}),
		),
	).toBe("");
});
