import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8");
const rule = (selector: string) =>
	css.split("}").find((block) => block.trim().startsWith(selector)) ?? "";

describe("the first screen under the cookie banner", () => {
	it("scrolls when its content is taller than the space left, so the send row stays reachable", () => {
		expect(rule('.welcome-panel:not([data-layout="chat"]) {')).toMatch(
			/overflow-y:\s*auto/,
		);
	});
	it("subtracts the banner from its small-screen minimum height", () => {
		expect(css).toMatch(
			/min-height:\s*calc\(100dvh - 76px - var\(--consent-banner-height, 0px\)\)/,
		);
	});
});
