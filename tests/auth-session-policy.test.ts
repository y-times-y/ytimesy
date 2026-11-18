import { expect, it, vi } from "vitest";

vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		APP_URL: "https://app.example.test",
		BETTER_AUTH_SECRET: "x".repeat(32),
		GITHUB_OAUTH_CLIENT_ID: "id",
		GITHUB_OAUTH_CLIENT_SECRET: "secret",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});
vi.mock("../src/server/adapters/database", () => ({ database: () => ({}) }));

import { authOptions } from "../src/server/auth/auth";

it("signs in from a verification link, never after sign-up, and ends sessions on a password reset", () => {
	const options = authOptions();
	expect(options.emailVerification.autoSignInAfterVerification).toBe(true);
	expect(options.emailAndPassword.requireEmailVerification).toBe(true);
	expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
	expect(options.emailAndPassword.autoSignIn).toBe(false);
});
