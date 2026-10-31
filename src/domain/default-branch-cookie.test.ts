import { describe, expect, it } from "vitest";
import {
	savedDefaultBranchCookie,
	savedDefaultBranchesFromCookies,
} from "./default-branch-cookie";

describe("default branch cookie", () => {
	it("round-trips, newest first, and refuses what it cannot store", () => {
		const first = savedDefaultBranchCookie({}, 12, "main");
		expect(first).toMatch(/^ytimesy-branches=12~main;/);
		const saved = savedDefaultBranchesFromCookies(
			`a=b; ${first?.split(";")[0]}`,
		);
		expect(saved).toEqual({ "12": "main" });
		expect(savedDefaultBranchCookie(saved, 12, "main")).toBeNull();
		const next = savedDefaultBranchCookie(saved, 34, "release/2.x");
		expect(savedDefaultBranchesFromCookies(next)).toEqual({
			"34": "release/2.x",
			"12": "main",
		});
		expect(savedDefaultBranchCookie(saved, 34, "bad;branch")).toBeNull();
		expect(
			savedDefaultBranchesFromCookies("ytimesy-branches=x~main!5~a b!6~dev"),
		).toEqual({ "6": "dev" });
	});
});
