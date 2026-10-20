import { expect, it, vi } from "vitest";

vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "https://app.example.test",
		BETTER_AUTH_SECRET: "x".repeat(32),
		GITHUB_OAUTH_CLIENT_ID: "id",
		GITHUB_OAUTH_CLIENT_SECRET: "secret",
	}),
}));
vi.mock("../src/server/adapters/database", () => ({ database: () => ({}) }));

import { authOptions } from "../src/server/auth/auth";

it("never signs in from a verification link and ends sessions on a password reset", () => {
	const options = authOptions();
	expect(options.emailVerification.autoSignInAfterVerification).toBe(false);
	expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
	expect(options.emailAndPassword.autoSignIn).toBe(false);
});
