import { expect, it } from "vitest";
import { authCallbackErrorMessage } from "../src/domain/auth-callback";
import {
	githubAppIdentityMatchesSignIn,
	needsGithubSetup,
} from "../src/domain/github-sign-in";
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

it("sends GitHub connection errors back to onboarding", () => {
	expect(needsGithubSetup("Connect GitHub to choose repositories.")).toBe(true);
	expect(needsGithubSetup("Reconnect GitHub.")).toBe(true);
	expect(
		needsGithubSetup("GitHub access expired or was denied. Reconnect GitHub."),
	).toBe(true);
	expect(needsGithubSetup("Project is not available.")).toBe(false);
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
	).toEqual(["github", "google"]);
});

it("turns OAuth callback failures into a retryable sign-in message", () => {
	expect(authCallbackErrorMessage(undefined)).toBeNull();
	expect(authCallbackErrorMessage("state_mismatch")).toBe(
		"Sign-in was interrupted. Try again from this page.",
	);
	expect(authCallbackErrorMessage("unable_to_link_account")).toBe(
		"That email already uses a different sign-in method.",
	);
	expect(authCallbackErrorMessage("unknown")).toBe(
		"Sign-in did not complete. Try again.",
	);
});
