import { expect, it } from "vitest";
import { memberSince, signInMethods } from "./sign-in-methods";

it("maps Better Auth providers to sign-in methods, once each, in a fixed order", () => {
	expect(signInMethods(["credential", "github", "github"])).toEqual([
		"github",
		"email",
	]);
	expect(signInMethods(["google"])).toEqual(["google"]);
	expect(signInMethods(["something-else"])).toEqual([]);
});

it("shows the month and year the account was created", () => {
	expect(memberSince("2026-11-02T08:00:00Z", "en-US")).toBe("November 2026");
	expect(memberSince("not a date")).toBeNull();
});
