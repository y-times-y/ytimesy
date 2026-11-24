import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadChip, titleText } from "./agent-reference-chips";

// Comments out, so a rule's selector is just its selector.
const css = readFileSync(
	new URL("../../styles.css", import.meta.url),
	"utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector list ends in or contains `selector` as a whole rule start. */
function rule(selector: string) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
	const rules = [...css.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
		.filter((match) =>
			(match[2] ?? "")
				.split(",")
				.some((part) => new RegExp(`^\\s*${escaped}\\s*$`).test(part)),
		)
		.map((match) => match[3] ?? "");
	expect(rules.length, `${selector} has a rule`).toBeGreaterThan(0);
	return rules.join("\n");
}

const LONG =
	"Sidebar: all threads under their project, with the Super agent first, and the Threads list grouped by status with a Settled fold";

/**
 * A thread chip in a message bubble (or a phone's narrow column) must never be
 * wider than its container: the chip shrinks, the Y mark and the readable id
 * stay, the title ends in an ellipsis and the whole title is the tooltip.
 * (Before: an inline-block chip whose title kept a fixed width, so a long
 * title ran past the bubble's edge.) Measured in a real browser at 700, 360
 * and 280 px in the preview; these pin the rules that do it.
 */
describe("a thread chip never leaves its container", () => {
	it("is a shrinking, clipping flex row", () => {
		const chip = rule(".session-markdown a.reference-chip");
		expect(chip).toMatch(/display:\s*inline-flex/);
		expect(chip).toMatch(/min-width:\s*0/);
		expect(chip).toMatch(/max-width:\s*100%/);
		expect(chip).toMatch(/overflow:\s*hidden/);
		// A box that clips has its bottom edge for a baseline: top aligns it with the text.
		expect(chip).toMatch(/vertical-align:\s*top/);
	});
	it("lets the title shrink and end in an ellipsis, and keeps the mark and the id whole", () => {
		const label = rule(".reference-chip-label");
		expect(label).toMatch(/flex:\s*0 1 auto/);
		expect(label).toMatch(/min-width:\s*0/);
		expect(label).toMatch(/overflow:\s*hidden/);
		expect(label).toMatch(/text-overflow:\s*ellipsis/);
		expect(label).toMatch(/white-space:\s*nowrap/);
		expect(rule(".reference-chip-id")).toMatch(/flex:\s*0 0 auto/);
		expect(rule(".reference-chip-icon")).toMatch(/flex:\s*0 0 auto/);
	});
	it("a pull request chip in its group shrinks too", () => {
		expect(rule(".reference-chip-group")).toMatch(/min-width:\s*0/);
		expect(rule(".reference-chip-group > a.reference-chip")).toMatch(
			/flex:\s*0 1 auto/,
		);
	});
});

describe("the chip carries the whole title as its tooltip", () => {
	it("a very long title is cut by CSS only: the id and title are whole in the markup, and the tooltip has both", () => {
		const html = renderToStaticMarkup(
			<ThreadChip
				id="7e86b684-3f5b-45de-925e-1f5ec68ff80c"
				label="ytimesy-44"
				title={LONG}
				threadNumber={44}
			/>,
		);
		expect(html).toContain(`title="ytimesy-44 · ${LONG}"`);
		expect(html).toContain('data-thread-label="true">ytimesy-44<');
		expect(html).toContain(`class="reference-chip-label">${LONG}<`);
	});
	it("reads the title out of a reply's link text, a string or several", () => {
		expect(titleText("Fix login")).toBe("Fix login");
		expect(titleText(["Fix ", "login"])).toBe("Fix login");
		expect(titleText(undefined)).toBe("");
		const html = renderToStaticMarkup(
			<ThreadChip id="c1" label="web-1" title={["Fix ", "login"]} />,
		);
		expect(html).toContain('title="web-1 · Fix login"');
	});
});
