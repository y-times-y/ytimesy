import { describe, expect, it } from "vitest";
import { readableModelCitations } from "./model-citation";

it("renders unresolved model citations honestly and suppresses streaming fragments", () => {
	expect(readableModelCitations("Cost. citeturn1search0")).toBe(
		"Cost. (source unavailable)",
	);
	expect(
		readableModelCitations("Other citeturn82view7turn93search2 text"),
	).toBe("Other (source unavailable) text");
	for (const fragment of ["", "c", "ci", "cit", "cite", "citeturn1se"])
		expect(readableModelCitations(`Text ${fragment}`)).toBe("Text ");
	expect(readableModelCitations("[Pricing](https://example.com/pricing)")).toBe(
		"[Pricing](https://example.com/pricing)",
	);
});

import {
	inlineMarkdownSegments,
	reportSummaryLine,
	withoutDanglingMarker,
	withoutPullRequestBlock,
} from "./markdown-text";

describe("a streaming reply", () => {
	it("hides a marker it has only begun", () => {
		expect(withoutDanglingMarker("**")).toBe("");
		expect(withoutDanglingMarker("Done.\n\n**")).toBe("Done.\n\n");
		expect(withoutDanglingMarker("Ran `")).toBe("Ran ");
		expect(withoutDanglingMarker("**research-1")).toBe("**research-1");
		expect(withoutDanglingMarker("a **b** c")).toBe("a **b** c");
	});
});

describe("a report's summary line", () => {
	it("keeps a plain first line and its Markdown", () => {
		expect(reportSummaryLine("Package name: `ytimesy`\n\nScripts: dev")).toBe(
			"Package name: `ytimesy`",
		);
		expect(reportSummaryLine("**Verified** the fix")).toBe(
			"**Verified** the fix",
		);
	});
	it("carries the result after a lead-in line", () => {
		expect(
			reportSummaryLine(
				'In `/x/tsconfig.json`, `compilerOptions` contains:\n\n- `target`: `"ES2022"`\n- `module`: `"ESNext"`\n\nCommand: `cat tsconfig.json`',
			),
		).toBe(
			'In `/x/tsconfig.json`, `compilerOptions` contains: `target`: `"ES2022"`; `module`: `"ESNext"`; Command: `cat tsconfig.json`',
		);
	});
	it("skips headings and stops at the limit", () => {
		expect(reportSummaryLine("## Result\n\nAll 12 tests pass")).toBe(
			"All 12 tests pass",
		);
		expect(reportSummaryLine("Found:\n- one\n- two\n- three", 18)).toBe(
			"Found: one; two",
		);
	});
});

describe("a line's inline Markdown", () => {
	it("splits code and bold, keeps other text", () => {
		expect(inlineMarkdownSegments("Created `a.txt` with **one** line")).toEqual(
			[
				{ kind: "text", text: "Created " },
				{ kind: "code", text: "a.txt" },
				{ kind: "text", text: " with " },
				{ kind: "strong", text: "one" },
				{ kind: "text", text: " line" },
			],
		);
	});
	it("drops a marker a cut left open", () => {
		expect(inlineMarkdownSegments("Ran `pnpm te…")).toEqual([
			{ kind: "text", text: "Ran pnpm te…" },
		]);
	});
});

describe("withoutPullRequestBlock", () => {
	it("hides the pull request description, closed or still streaming", () => {
		expect(
			withoutPullRequestBlock(
				"Done.\n\n<pull-request>\n## Summary\nAdds dark mode.\n</pull-request>",
			),
		).toBe("Done.");
		expect(withoutPullRequestBlock("Done.\n\n<pull-request>\n## Summ")).toBe(
			"Done.",
		);
		expect(withoutPullRequestBlock("No block here.")).toBe("No block here.");
	});
});
