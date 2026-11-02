import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	MenuSelect,
	menuSelectKeyTarget,
	menuSelectTypeahead,
} from "./menu-select";

const options = [
	{ value: "a", label: "Anthropic: Claude Fable 5.1" },
	{ value: "b", label: "OpenAI: GPT-6" },
	{ value: "c", label: "Google: Gemini" },
];

describe("menuSelectKeyTarget", () => {
	it("steps with the arrows and wraps at either end", () => {
		expect(menuSelectKeyTarget("ArrowDown", 0, 3)).toBe(1);
		expect(menuSelectKeyTarget("ArrowDown", 2, 3)).toBe(0);
		expect(menuSelectKeyTarget("ArrowUp", 0, 3)).toBe(2);
		expect(menuSelectKeyTarget("ArrowUp", 2, 3)).toBe(1);
	});

	it("starts from the first or last row when no row has focus", () => {
		expect(menuSelectKeyTarget("ArrowDown", -1, 3)).toBe(0);
		expect(menuSelectKeyTarget("ArrowUp", -1, 3)).toBe(2);
	});

	it("jumps with Home and End and ignores other keys", () => {
		expect(menuSelectKeyTarget("Home", 2, 3)).toBe(0);
		expect(menuSelectKeyTarget("End", 0, 3)).toBe(2);
		expect(menuSelectKeyTarget("Enter", 1, 3)).toBeNull();
		expect(menuSelectKeyTarget("ArrowDown", -1, 0)).toBeNull();
	});
});

describe("menuSelectTypeahead", () => {
	const texts = options.map((option) => option.label);

	it("moves to the next row whose text starts with the typed letters", () => {
		expect(menuSelectTypeahead(texts, "o", 0)).toBe(1);
		expect(menuSelectTypeahead(texts, "G", 1)).toBe(2);
		expect(menuSelectTypeahead(texts, "a", 0)).toBe(0);
		expect(menuSelectTypeahead(texts, "z", 0)).toBeNull();
		expect(menuSelectTypeahead(texts, "", 0)).toBeNull();
	});
});

describe("MenuSelect", () => {
	it("renders a listbox trigger with the chosen label, never a native select", () => {
		const html = renderToStaticMarkup(
			<MenuSelect
				value="a"
				onValueChange={() => {}}
				options={options}
				placeholder="Choose a model"
				aria-label="Model for OpenRouter"
			/>,
		);
		expect(html).not.toContain("<select");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-label="Model for OpenRouter"');
		expect(html).toContain("Anthropic: Claude Fable 5.1");
	});

	it("shows the placeholder until a value is chosen", () => {
		const html = renderToStaticMarkup(
			<MenuSelect
				value=""
				onValueChange={() => {}}
				options={options}
				placeholder="Choose a model"
				aria-label="Model"
			/>,
		);
		expect(html).toContain("Choose a model");
		expect(html).toContain("data-placeholder");
	});

	it("submits its value with a form through a hidden input", () => {
		const html = renderToStaticMarkup(
			<MenuSelect
				name="plan"
				value="b"
				onValueChange={() => {}}
				options={options}
			/>,
		);
		expect(html).toContain('type="hidden" name="plan" value="b"');
	});

	it("draws its menu with the composer pickers' surface and rows", () => {
		const source = readFileSync(
			new URL("./menu-select.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain('"project-picker menu-select-menu"');
		expect(source).toContain('"project-picker-choice menu-select-choice"');
		expect(source).toContain('role="option"');
		expect(source).toContain('role="listbox"');
	});
});
