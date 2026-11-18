import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { subject: string; actionUrl: string }[]);

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
vi.mock("../src/server/adapters/email", async (importOriginal) => ({
	...(await importOriginal<object>()),
	persistAuthEmail: async (input: { subject: string; actionUrl: string }) => {
		sent.push(input);
	},
	authEmailDeliveryConfigured: () => true,
}));

import { authOptions } from "../src/server/auth/auth";

it("sends a six-digit code, never a link, and the code signs the person in", async () => {
	const db: Record<string, unknown[]> = {
		auth_user: [],
		auth_session: [],
		auth_account: [],
		auth_verification: [],
	};
	// The real options, with an in-memory store and without the hooks that
	// write to the production database.
	const auth = betterAuth({
		...authOptions(),
		database: memoryAdapter(db),
		databaseHooks: {},
		rateLimit: { enabled: false },
		plugins: authOptions().plugins.filter(
			(plugin: { id: string }) => plugin.id === "email-otp",
		),
		advanced: {},
	} as never);
	await auth.api.signUpEmail({
		body: { email: "ada@example.test", password: "password123", name: "Ada" },
	});
	expect(sent).toHaveLength(1);
	expect(sent[0].actionUrl).toMatch(/^\d{6}$/);
	expect(sent[0].subject).toBe(`${sent[0].actionUrl} is your ytimesy code`);
	expect(sent[0].actionUrl).not.toContain("http");

	const response = await auth.api.verifyEmailOTP({
		body: { email: "ada@example.test", otp: sent[0].actionUrl },
		asResponse: true,
	});
	expect(response.status).toBe(200);
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	const session = await auth.api.getSession({
		headers: new Headers({ cookie }),
	});
	expect(session?.user.email).toBe("ada@example.test");
});
