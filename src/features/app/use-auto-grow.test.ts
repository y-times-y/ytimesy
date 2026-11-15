import { afterEach, expect, it, vi } from "vitest";
import { growToFit } from "./use-auto-grow";

afterEach(() => vi.unstubAllGlobals());

/** A text box as the browser reports it after its height is set to auto. */
function box(measure: {
	boxSizing: "border-box" | "content-box";
	scrollHeight: number;
	offsetHeight: number;
	clientHeight: number;
	paddingTop?: string;
	paddingBottom?: string;
}) {
	vi.stubGlobal("getComputedStyle", () => ({
		boxSizing: measure.boxSizing,
		paddingTop: measure.paddingTop ?? "0px",
		paddingBottom: measure.paddingBottom ?? "0px",
	}));
	const heights: string[] = [];
	const element = {
		style: {
			set height(value: string) {
				heights.push(value);
			},
		},
		scrollHeight: measure.scrollHeight,
		offsetHeight: measure.offsetHeight,
		clientHeight: measure.clientHeight,
	};
	return { element: element as unknown as HTMLTextAreaElement, heights };
}

it("resets to auto first, then sizes a border-box field to its text plus its borders", () => {
	const { element, heights } = box({
		boxSizing: "border-box",
		scrollHeight: 90,
		offsetHeight: 92,
		clientHeight: 90,
	});
	growToFit(element);
	expect(heights).toEqual(["auto", "92px"]);
});

it("sizes a content-box field to its text without its padding", () => {
	const { element, heights } = box({
		boxSizing: "content-box",
		scrollHeight: 90,
		offsetHeight: 90,
		clientHeight: 90,
		paddingTop: "8px",
		paddingBottom: "8px",
	});
	growToFit(element);
	expect(heights).toEqual(["auto", "74px"]);
});

it("never sets a negative height", () => {
	const { element, heights } = box({
		boxSizing: "content-box",
		scrollHeight: 10,
		offsetHeight: 10,
		clientHeight: 10,
		paddingTop: "20px",
		paddingBottom: "20px",
	});
	growToFit(element);
	expect(heights.at(-1)).toBe("0px");
});
