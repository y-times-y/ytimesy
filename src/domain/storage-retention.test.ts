import { describe, expect, it } from "vitest";
import {
	IDLE_WORKSPACE_DAYS,
	storageAlert,
	storageLevel,
	storageUsage,
} from "./storage-retention";

const vm = (storage: number) => ({ resources: { storage } });

describe("storageUsage", () => {
	it("adds every machine's disk and charges each snapshot a full default disk", () => {
		const usage = storageUsage([vm(32768), vm(16384)], 2, 3125);
		expect(usage.usedGiB).toBe(32 + 16 + 64);
		expect(usage.fraction).toBeCloseTo(112 / 3125);
	});
});

describe("storageLevel", () => {
	it.each([
		[0.5, "ok"],
		[0.8, "warn-80"],
		[0.899, "warn-80"],
		[0.9, "warn-90"],
		[0.949, "warn-90"],
		[0.95, "full"],
		[1.2, "full"],
	] as const)("%s is %s", (fraction, level) => {
		expect(storageLevel(fraction)).toBe(level);
	});
});

describe("storageAlert", () => {
	const now = new Date("2026-11-26T10:00:00Z");
	it("says nothing below 80%", () => {
		expect(storageAlert("ok", 100, 3125, now)).toBeNull();
	});
	it("is keyed by level and day so the owner hears once a day", () => {
		const alert = storageAlert("warn-90", 2900, 3125, now);
		expect(alert?.kind).toBe("storage-quota");
		expect(alert?.key).toBe("warn-90:2026-11-26");
		expect(alert?.text).toContain("2900");
	});
	it("treats the 95% guard as the 90% alert's day key too", () => {
		expect(storageAlert("full", 3000, 3125, now)?.key).toBe("full:2026-11-26");
	});
});

describe("idle window", () => {
	it("is seven days", () => {
		expect(IDLE_WORKSPACE_DAYS).toBe(7);
	});
});
