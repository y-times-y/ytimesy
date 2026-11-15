import { describe, expect, it } from "vitest";
import { RowHeights } from "./transcript-row-heights";

const row = (key: string, kind = "agentMessage", estimate = 100) => ({
	key,
	kind,
	estimate,
});

describe("RowHeights", () => {
	it("gives a row of a kind it has not measured its own estimate", () => {
		const heights = new RowHeights();
		expect(heights.estimate(row("a"))).toBe(100);
		expect(heights.placeholder(row("a"))).toBe(100);
	});

	it("gives a measured row its own height, at the width it was measured", () => {
		const heights = new RowHeights();
		heights.measured(row("a"), { box: 230, margins: 14 }, 720);
		expect(heights.estimate(row("a"))).toBe(244);
		expect(heights.placeholder(row("a"))).toBe(230);
		// Rows now measure at another width: text wraps differently there.
		heights.measured(row("b"), { box: 50, margins: 0 }, 500);
		expect(heights.estimate(row("a"))).not.toBe(244);
	});

	it("corrects a kind's estimates by what its rows measured", () => {
		const heights = new RowHeights();
		for (const key of ["a", "b", "c", "d"])
			heights.measured(row(key), { box: 190, margins: 10 }, 720);
		// (4 × 200 + 400) / (4 × 100 + 400): measured twice the estimate, held
		// back by the prior until more rows agree.
		expect(heights.estimate(row("new"))).toBe(150);
		// Other kinds keep their own estimates.
		expect(heights.estimate(row("user", "userMessage", 60))).toBe(60);
	});

	it("learns from each row once, however often it is measured", () => {
		const heights = new RowHeights();
		heights.measured(row("a"), { box: 300, margins: 0 }, 720);
		const once = heights.estimate(row("new"));
		for (let index = 0; index < 20; index++)
			heights.measured(row("a"), { box: 300, margins: 0 }, 720);
		expect(heights.estimate(row("new"))).toBe(once);
	});

	it("keeps a kind's correction within bounds", () => {
		const heights = new RowHeights();
		for (let index = 0; index < 50; index++)
			heights.measured(
				row(`r${index}`, "fileChange", 10),
				{ box: 4_000, margins: 0 },
				720,
			);
		expect(heights.estimate(row("new", "fileChange", 10))).toBe(40);
	});

	it("gives a row not measured its estimate less its kind's usual margins as room", () => {
		const heights = new RowHeights();
		heights.measured(row("a"), { box: 86, margins: 14 }, 720);
		heights.measured(row("b"), { box: 86, margins: 14 }, 720);
		// The list's own estimate for the row, when it holds one.
		expect(heights.placeholder(row("new"), 300)).toBe(286);
		expect(heights.placeholder(row("tiny"), 5)).toBe(0);
	});

	it("forgets the rows measured longest ago", () => {
		const heights = new RowHeights(2);
		heights.measured(row("a"), { box: 500, margins: 0 }, 720);
		heights.measured(row("b"), { box: 500, margins: 0 }, 720);
		heights.measured(row("c"), { box: 500, margins: 0 }, 720);
		expect(heights.placeholder(row("c"))).toBe(500);
		expect(heights.placeholder(row("b"))).toBe(500);
		// Forgotten: back to its kind's corrected estimate.
		expect(heights.placeholder(row("a"))).not.toBe(500);
	});

	it("knows a row's height only once it was measured at the list's width", () => {
		const heights = new RowHeights();
		expect(heights.hasMeasured(row("a"))).toBe(false);
		heights.measured(row("a"), { box: 120, margins: 8 }, 600);
		expect(heights.hasMeasured(row("a"))).toBe(true);
		expect(heights.hasMeasured(row("b"))).toBe(false);
		// Rows measured at another width count as unmeasured until they mount again.
		heights.measured(row("b"), { box: 90, margins: 8 }, 300);
		expect(heights.hasMeasured(row("a"))).toBe(false);
		expect(heights.hasMeasured(row("b"))).toBe(true);
	});
});
