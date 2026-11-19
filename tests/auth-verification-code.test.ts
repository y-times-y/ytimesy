import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { expect, it, vi } from "vitest";

const sent = vi.hoisted(
	() => [] as { subject: string; actionUrl: string; purpose: string }[],
);

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
	persistAuthEmail: async (input: {
		subject: string;
		actionUrl: string;
		purpose: string;
	}) => {
		sent.push(input);
	},
	authEmailDeliveryConfigured: () => true,
}));

import { authOptions } from "../src/server/auth/auth";

/** The endpoints these tests call, typed by hand: the options are cast to build the instance. */
type TestAuth = {
	api: {
		signUpEmail(input: {
			body: { email: string; password: string; name: string };
		}): Promise<{ token: string | null; user: Record<string, unknown> }>;
		signInEmail(input: {
			body: { email: string; password: string };
		}): Promise<unknown>;
		verifyEmailOTP(input: {
			body: { email: string; otp: string };
			asResponse?: boolean;
		}): Promise<Response>;
		getSession(input: {
			headers: Headers;
		}): Promise<{ user: { email: string } } | null>;
	};
};

/**
 * The real options with an in-memory store and without the hooks that write
 * to the production database. The instance is also what the sign-up for an
 * existing address sends its code through, as in production (createAuth).
 */
function realAuth() {
	const db: Record<string, unknown[]> = {
		auth_user: [],
		auth_session: [],
		auth_account: [],
		auth_verification: [],
	};
	let instance: unknown;
	const auth = betterAuth({
		...authOptions(() => instance as never),
		database: memoryAdapter(db),
		databaseHooks: {},
		rateLimit: { enabled: false },
		plugins: authOptions().plugins.filter(
			(plugin: { id: string }) => plugin.id === "email-otp",
		),
		advanced: {},
	} as never);
	instance = auth;
	return auth as unknown as TestAuth;
}

const signUp = (auth: ReturnType<typeof realAuth>, password = "password123") =>
	auth.api.signUpEmail({
		body: { email: "ada@example.test", password, name: "Ada" },
	});

it("sends a six-digit code, never a link, and the code signs the person in", async () => {
	sent.length = 0;
	const auth = realAuth();
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

const VERIFIED_ONCE = "ada@example.test";

async function verifiedAccount() {
	sent.length = 0;
	const auth = realAuth();
	const fresh = await signUp(auth);
	await auth.api.verifyEmailOTP({
		body: { email: VERIFIED_ONCE, otp: sent[0].actionUrl },
	});
	sent.length = 0;
	return { auth, fresh };
}

it("answers a sign-up for an address that has an account like a new one, and tells its owner by email", async () => {
	const { auth, fresh } = await verifiedAccount();
	const again = await signUp(auth, "a-different-password1");
	// Same answer: the page cannot tell who has an account.
	expect(again.token).toBeNull();
	expect(Object.keys(again).sort()).toEqual(Object.keys(fresh).sort());
	expect(Object.keys(again.user).sort()).toEqual(
		Object.keys(fresh.user).sort(),
	);
	// The owner gets a short "you already have an account" message, not a code.
	await vi.waitFor(() => expect(sent).toHaveLength(1));
	expect(sent[0].purpose).toBe("account-exists");
	expect(sent[0].actionUrl).toBe("https://app.example.test/auth/sign-in");
	expect(sent[0].subject).toBe("You already have a ytimesy account");
	expect(sent[0].actionUrl).not.toMatch(/\d{6}/);
});

it("signing up again changes nothing about the existing account", async () => {
	const { auth } = await verifiedAccount();
	await signUp(auth, "a-different-password1");
	await vi.waitFor(() => expect(sent).toHaveLength(1));
	// The old password still signs in; the one typed into the sign-up does not.
	await expect(
		auth.api.signInEmail({
			body: { email: VERIFIED_ONCE, password: "password123" },
		}),
	).resolves.toBeDefined();
	await expect(
		auth.api.signInEmail({
			body: { email: VERIFIED_ONCE, password: "a-different-password1" },
		}),
	).rejects.toBeDefined();
});

it("sends an address that never finished verifying a fresh code that works", async () => {
	sent.length = 0;
	const auth = realAuth();
	await signUp(auth);
	expect(sent).toHaveLength(1);
	// The person comes back and signs up again without having used the code.
	const again = await signUp(auth);
	expect(again.token).toBeNull();
	await vi.waitFor(() => expect(sent).toHaveLength(2));
	expect(sent[1].purpose).toBe("verify-email");
	expect(sent[1].actionUrl).toMatch(/^\d{6}$/);
	expect(sent[1].subject).toBe(`${sent[1].actionUrl} is your ytimesy code`);
	const response = await auth.api.verifyEmailOTP({
		body: { email: VERIFIED_ONCE, otp: sent[1].actionUrl },
		asResponse: true,
	});
	expect(response.status).toBe(200);
});
