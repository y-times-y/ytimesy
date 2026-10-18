import { describe, expect, it } from "vitest";
import {
	returnToForLocation,
	safeReturnTo,
	sanitizedReturnToUrl,
	withReturnTo,
} from "./return-to";

const evidence =
	"/projects/0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f/evidence/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("return path after sign-in", () => {
	it.each([
		[evidence, evidence],
		["/", "/"],
		["/?chat=abc#latest", "/?chat=abc#latest"],
		["/projects/x?tab=diff", "/projects/x?tab=diff"],
		["/a/../projects/x", "/projects/x"],
		["/x?redirectTo=/y&keep=1", "/x?keep=1"],
	])("allows the local path %s", (value, expected) => {
		expect(safeReturnTo(value)).toBe(expected);
	});

	it.each([
		["absolute https", "https://evil.example/x"],
		["absolute http", "http://evil.example"],
		["javascript scheme", "javascript:alert(1)"],
		["data scheme", "data:text/html,<script>alert(1)</script>"],
		["protocol-relative", "//evil.example/x"],
		["backslash host", "/\\evil.example"],
		["backslash prefix", "\\\\evil.example"],
		["encoded protocol-relative", "/%2F%2Fevil.example"],
		["encoded backslash", "/%5Cevil.example"],
		["tab inside", "/\t/evil.example"],
		["newline", "/x\nLocation: https://evil.example"],
		["null byte", "/x\u0000"],
		["DEL", "/x\u007f"],
		["C1 control", "/x\u0085"],
		["leading space", " /x"],
		["relative without slash", "projects/x"],
		["empty", ""],
		["sign-in loop", "/auth/sign-in"],
		["api route", "/api/account"],
		["too long", `/${"a".repeat(3000)}`],
	])("rejects %s", (_label, value) => {
		expect(safeReturnTo(value)).toBe("/");
	});

	it("rejects anything that is not a string", () => {
		for (const value of [undefined, null, 42, ["/x"], { to: "/x" }])
			expect(safeReturnTo(value)).toBe("/");
	});
});

describe("return path for the page being viewed", () => {
	it("is the deep link itself where sign-in is shown in place", () => {
		expect(returnToForLocation(evidence, "")).toBe(evidence);
		expect(returnToForLocation("/", "?chat=1")).toBe("/?chat=1");
	});

	it("is the validated parameter on sign-in pages", () => {
		expect(
			returnToForLocation(
				"/auth/sign-up",
				`?redirectTo=${encodeURIComponent(evidence)}`,
			),
		).toBe(evidence);
		expect(
			returnToForLocation("/auth/sign-in", "?redirectTo=https://evil.example"),
		).toBe("/");
		expect(returnToForLocation("/auth/sign-in", "")).toBe("/");
	});
});

describe("carrying the return path between sign-in views", () => {
	it("adds it to sign-in links and leaves other links alone", () => {
		expect(withReturnTo("/auth/sign-up", evidence)).toBe(
			`/auth/sign-up?redirectTo=${encodeURIComponent(evidence)}`,
		);
		expect(withReturnTo("/auth/two-factor?redirectTo=%2Fold", evidence)).toBe(
			`/auth/two-factor?redirectTo=${encodeURIComponent(evidence)}`,
		);
		expect(withReturnTo("/auth/sign-up", "/")).toBe("/auth/sign-up");
		expect(withReturnTo("/auth/sign-up", "//evil.example")).toBe(
			"/auth/sign-up",
		);
		expect(withReturnTo(evidence, "/other")).toBe(evidence);
	});

	it("rewrites an unsafe parameter in the address bar and keeps a safe one", () => {
		expect(
			sanitizedReturnToUrl(
				"/auth/sign-in",
				"?redirectTo=%2F%2Fevil.example&error=x",
				"#f",
			),
		).toBe("/auth/sign-in?error=x#f");
		expect(
			sanitizedReturnToUrl(
				"/auth/sign-in",
				`?redirectTo=${encodeURIComponent(evidence)}`,
				"",
			),
		).toBeNull();
		expect(sanitizedReturnToUrl("/auth/sign-in", "?error=x", "")).toBeNull();
	});
});
