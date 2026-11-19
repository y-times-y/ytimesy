import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	ModelDetailCard,
	type ModelDetailSpec,
	ModelRowMeta,
	ReasoningSlider,
} from "./model-detail";

const levels = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
];
const priced: ModelDetailSpec = {
	id: "openai/gpt-6.2-sol",
	provider: "api",
	label: "GPT Sol",
	logo: "openai",
	priceId: "openai/gpt-6.2-sol",
	plan: false,
};

function card(
	spec: ModelDetailSpec,
	extra: Partial<Parameters<typeof ModelDetailCard>[0]> = {},
) {
	return renderToStaticMarkup(
		createElement(ModelDetailCard, {
			spec,
			expanded: true,
			onExpandedChange: () => {},
			favorite: false,
			onToggleFavorite: () => {},
			...extra,
		}),
	);
}

describe("model detail card", () => {
	it("shows the context window and both prices from the tables", () => {
		const html = card(priced);
		expect(html).toContain("Context");
		expect(html).toContain("Input per 1M");
		expect(html).toContain("$2");
		expect(html).toContain("Output per 1M");
		expect(html).toContain("$10");
		expect(html).toContain("Add to favorites");
	});
	it("shows Included in plan instead of a price for a plan model", () => {
		const html = card({ ...priced, plan: true });
		expect(html).toContain("Included in plan");
		expect(html).not.toContain("Input per 1M");
	});
	it("leaves out every field it has no data for", () => {
		const html = card({ ...priced, priceId: "vendor/unknown" });
		expect(html).not.toContain("Context");
		expect(html).not.toContain("Input per 1M");
		expect(html).not.toContain("Reasoning");
	});
	it("offers the slider only when given the composer's reasoning setting", () => {
		const html = card(priced, {
			reasoning: { levels, valueId: "medium", onChange: () => {} },
		});
		expect(html).toContain('role="slider"');
		expect(html).toContain('aria-valuetext="Medium"');
		expect(html).toContain('aria-valuenow="1"');
	});
	it("labels a favorite and exposes the expand state", () => {
		const html = card(priced, { favorite: true, expanded: false });
		expect(html).toContain("In favorites");
		expect(html).toContain('aria-expanded="false"');
	});
});

describe("reasoning slider", () => {
	it("has one named step per level and a keyboard-operable thumb", () => {
		const html = renderToStaticMarkup(
			createElement(ReasoningSlider, {
				levels,
				valueId: "high",
				onChange: () => {},
			}),
		);
		expect(html).toContain('aria-label="Low"');
		expect(html).toContain('aria-label="High"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('aria-valuemax="2"');
	});
});

describe("row meta", () => {
	it("keeps the check slot when unselected and speaks the price", () => {
		const html = renderToStaticMarkup(
			createElement(ModelRowMeta, {
				priceId: priced.priceId,
				plan: false,
				selected: false,
			}),
		);
		expect(html).toContain("model-row-check");
		expect(html).toContain("$2 / $10");
		expect(html).toContain("$2 input and $10 output per million tokens");
	});
	it("shows nothing but the check slot for an unpriced model", () => {
		const html = renderToStaticMarkup(
			createElement(ModelRowMeta, {
				priceId: "vendor/unknown",
				plan: false,
				selected: true,
			}),
		);
		expect(html).not.toContain("model-row-price");
		expect(html).toContain("model-row-check");
	});
});

describe("cardSide", () => {
	it("keeps the card on the right while it fits, then flips left, then goes under the list", async () => {
		const { cardSide } = await import("./model-detail");
		expect(cardSide({ left: 100, right: 400 }, 260, 1200)).toBe("right");
		// The user's case: the picker near the right edge of the window.
		expect(cardSide({ left: 560, right: 860 }, 260, 1000)).toBe("left");
		// No room on either side.
		expect(cardSide({ left: 40, right: 340 }, 260, 400)).toBe("inline");
	});
});

describe("selectedModelSpec", () => {
	it("gives the card the selected model before any row is hovered", async () => {
		const { selectedModelSpec } = await import("./model-detail");
		const model = { label: "GPT-A", contextWindow: null };
		expect(selectedModelSpec("codex", "gpt-a", model)).toMatchObject({
			id: "gpt-a",
			provider: "codex",
			label: "GPT-A",
			plan: true,
		});
		expect(selectedModelSpec("api", "claude-code/sonnet", model)).toMatchObject(
			{ provider: "api", logo: "anthropic" },
		);
		// No model selected: no card to show.
		expect(selectedModelSpec("codex", "", undefined)).toBeNull();
	});
});

describe("reasoning is shown once, in the card", () => {
	it("keeps the menu's settings free of a Reasoning row and the CSS free of a hide rule", async () => {
		const { readFileSync } = await import("node:fs");
		const css = readFileSync(
			new URL("./model-picker.css", import.meta.url),
			"utf8",
		);
		// The old fix hid the row with CSS on wide screens only, so narrow and
		// touch screens showed reasoning twice.
		expect(css).not.toContain("data-detail-reasoning");
		const picker = readFileSync(
			new URL("./harness-picker.tsx", import.meta.url),
			"utf8",
		);
		expect(picker).not.toContain("data-detail-reasoning");
		// One card, kept while the mouse moves between rows: no key that
		// re-creates it (and replays its fade) on every hover.
		expect(picker).not.toMatch(/<ModelDetailCard[^>]*\bkey=/);
	});
});
