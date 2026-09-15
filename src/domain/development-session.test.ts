import { describe, expect, it } from "vitest";
import {
	developmentSessionSecretMatches,
	developmentSessionTarget,
	providedDevelopmentSessionSecret,
} from "./development-session";

describe("developmentSessionTarget", () => {
	it("stays off unless both a 32-character secret and a user id are set", () => {
		expect(developmentSessionTarget({})).toBeNull();
		expect(
			developmentSessionTarget({
				DEV_AUTH_BYPASS_SECRET: "short",
				DEV_AUTH_USER_ID: "user-1",
			}),
		).toBeNull();
		expect(
			developmentSessionTarget({
				DEV_AUTH_BYPASS_SECRET: "a".repeat(32),
			}),
		).toBeNull();
		expect(
			developmentSessionTarget({
				DEV_AUTH_USER_ID: "user-1",
			}),
		).toBeNull();
		expect(
			developmentSessionTarget({
				DEV_AUTH_BYPASS_SECRET: "a".repeat(32),
				DEV_AUTH_USER_ID: "user-1",
			}),
		).toEqual({ secret: "a".repeat(32), userId: "user-1" });
	});
});

describe("developmentSessionSecretMatches", () => {
	it("accepts only the configured secret", () => {
		const secret = "a".repeat(32);
		expect(developmentSessionSecretMatches(secret, secret)).toBe(true);
		expect(developmentSessionSecretMatches(secret, "b".repeat(32))).toBe(false);
		expect(developmentSessionSecretMatches(secret, undefined)).toBe(false);
		expect(developmentSessionSecretMatches(secret, "short")).toBe(false);
	});
});

describe("providedDevelopmentSessionSecret", () => {
	it("prefers the query secret over the header", () => {
		expect(providedDevelopmentSessionSecret(" query ", "header")).toBe("query");
		expect(providedDevelopmentSessionSecret(null, " header ")).toBe("header");
		expect(providedDevelopmentSessionSecret(" ", " ")).toBeUndefined();
	});
});
