import { expect, it } from "vitest";
import { githubAppIdentityMatchesSignIn } from "../src/domain/github-sign-in";
import {
	authErrorMessage,
	isUnverifiedEmailError,
} from "../src/features/auth/auth-error";
import {
	authTrustedOrigins,
	googleOAuthConfigured,
} from "../src/server/auth/providers";

it("only binds GitHub App identity to GitHub sign-in accounts", () => {
	expect(githubAppIdentityMatchesSignIn("123", "123")).toBe(true);
	expect(githubAppIdentityMatchesSignIn("123", "456")).toBe(false);
	expect(githubAppIdentityMatchesSignIn(undefined, "789")).toBe(true);
});

it("trusts localhost and 127.0.0.1 for local Better Auth origins", () => {
	expect(authTrustedOrigins("http://127.0.0.1:3999")).toEqual([
		"http://127.0.0.1:3999",
		"http://localhost:3999",
	]);
	expect(googleOAuthConfigured({})).toBe(false);
	expect(
		googleOAuthConfigured({
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "secret",
		}),
	).toBe(true);
});

it("maps Better Auth codes without leaking provider details", () => {
	expect(authErrorMessage({ code: "EMAIL_NOT_VERIFIED" }, "fallback")).toBe(
		"Verify your email before signing in.",
	);
	expect(isUnverifiedEmailError({ code: "EMAIL_NOT_VERIFIED" })).toBe(true);
	expect(
		authErrorMessage(
			{ code: "UNKNOWN", message: "http://secret" },
			"Try again.",
		),
	).toBe("Try again.");
});
