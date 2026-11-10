import { describe, expect, it } from "vitest";
import { boundActiveTurnItems } from "./active-turn-bound";
import type { SessionItem } from "./session-item";

const command = (id: string, size: number): SessionItem => ({
	kind: "commandExecution",
	id: id as SessionItem["id"],
	command: "x",
	cwd: null,
	status: "completed",
	output: "o".repeat(size),
	exitCode: 0,
});

describe("boundActiveTurnItems", () => {
	it("returns the same array under the budget", () => {
		const items = [command("a", 10_000)];
		expect(boundActiveTurnItems(items, 0, 100_000)).toBe(items);
	});

	it("trims oldest outputs first, keeps the newest whole and earlier turns alone", () => {
		const items = [
			command("earlier", 50_000),
			...Array.from({ length: 30 }, (_, i) => command(`c${i}`, 10_000)),
		];
		const bounded = boundActiveTurnItems(items, 1, 250_000);
		expect(bounded[0]).toBe(items[0]);
		const length = (item: SessionItem) =>
			item.kind === "commandExecution" ? (item.output?.length ?? 0) : 0;
		expect(length(bounded[1])).toBeLessThan(3_000);
		expect(bounded[30]).toBe(items[30]);
		const total = bounded.slice(1).reduce((sum, item) => sum + length(item), 0);
		expect(total).toBeLessThanOrEqual(250_000);
	});
});
