import { expect, it } from "vitest";
import {
	DEFAULT_USER_SHORT_WINDOW_MICRO_USD,
	DEFAULT_USER_WEEKLY_MICRO_USD,
} from "../scripts/usage-allowance-defaults";

// The allowances before this change; the new ones are a modest, generous step up.
const PREVIOUS_SHORT_WINDOW = 5_000_000;
const PREVIOUS_WEEKLY = 25_000_000;

it("raises each window's default allowance by a modest margin", () => {
	for (const [now, before] of [
		[Number(DEFAULT_USER_SHORT_WINDOW_MICRO_USD), PREVIOUS_SHORT_WINDOW],
		[Number(DEFAULT_USER_WEEKLY_MICRO_USD), PREVIOUS_WEEKLY],
	]) {
		expect(Number.isInteger(now)).toBe(true);
		expect(now / before).toBeGreaterThanOrEqual(1.15);
		expect(now / before).toBeLessThanOrEqual(1.25);
	}
});

it("deploy scripts take their defaults from the shared module", async () => {
	const { readFile } = await import("node:fs/promises");
	for (const file of ["deploy-production.ts", "deploy-edge-development.ts"]) {
		const source = await readFile(
			new URL(`../scripts/${file}`, import.meta.url),
			"utf8",
		);
		expect(source).toContain("DEFAULT_USER_SHORT_WINDOW_MICRO_USD");
		expect(source).toContain("DEFAULT_USER_WEEKLY_MICRO_USD");
		expect(source).not.toMatch(/\|\| "(?:5000000|25000000)"/);
	}
});
