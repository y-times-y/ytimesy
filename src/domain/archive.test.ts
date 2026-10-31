import { expect, it } from "vitest";
import { archiveDaysLeft } from "./archive";

it("counts the days left of the 30-day keep", () => {
	const at = "2026-10-01T00:00:00Z";
	expect(archiveDaysLeft(at, Date.parse("2026-10-01T01:00:00Z"))).toBe(29);
	expect(archiveDaysLeft(at, Date.parse("2026-10-30T12:00:00Z"))).toBe(0);
	expect(archiveDaysLeft(at, Date.parse("2026-12-01T00:00:00Z"))).toBe(0);
});
