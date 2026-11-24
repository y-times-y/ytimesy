import { expect, it } from "vitest";
import {
	isTestAccountId,
	isTestAddress,
	normalizeCaller,
	signedSessionCookie,
	TEST_ACCOUNT_EMAIL,
	TEST_ACCOUNT_ID,
} from "./test-account";

it("recognises only the reserved id and the .test domain", () => {
	expect(isTestAccountId(TEST_ACCOUNT_ID)).toBe(true);
	expect(isTestAccountId("someone-else")).toBe(false);
	expect(isTestAddress(TEST_ACCOUNT_EMAIL)).toBe(true);
	expect(isTestAddress("real@example.com")).toBe(false);
});
it("accepts thread ids as callers and rejects junk", () => {
	expect(
		normalizeCaller("6257ce66-4363-4862-a77b-e8226732f9e2"),
	).not.toBeNull();
	expect(normalizeCaller("")).toBeNull();
	expect(normalizeCaller("a\nb")).toBeNull();
	expect(normalizeCaller("x".repeat(500))).toBeNull();
});
it("uses the plain cookie name over http", () => {
	expect(signedSessionCookie("t", "s", false).name).toBe(
		"better-auth.session_token",
	);
});
