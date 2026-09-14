import { expect, it } from "vitest";
import { githubAppIdentityMatchesSignIn } from "../src/domain/github-sign-in";
import {
	authTrustedOrigins,
	configuredSocialProviders,
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
	expect(configuredSocialProviders({})).toEqual(["github"]);
	expect(
		configuredSocialProviders({
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "secret",
		}),
	).toEqual(["google", "github"]);
});
