import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, expect, it, vi } from "vitest";
import { authCaptchaPlugins } from "./auth";
import { turnstileSettings } from "./turnstile";

vi.mock("../adapters/database", () => ({ database: () => ({}) }));

const appUrl = "https://app.example.test";
const production = {
	YTIMESY_ENVIRONMENT: "production",
	TURNSTILE_SITE_KEY: "0x4AAAAAAA-site",
	TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret",
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("is required in production and off in development and tests", () => {
	expect(turnstileSettings(production)).toEqual({
		siteKey: production.TURNSTILE_SITE_KEY,
		secretKey: production.TURNSTILE_SECRET_KEY,
	});
	expect(() =>
		turnstileSettings({ ...production, TURNSTILE_SECRET_KEY: "" }),
	).toThrow(/requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/);
	expect(turnstileSettings({ YTIMESY_ENVIRONMENT: "development" })).toBeNull();
	expect(
		turnstileSettings({ ...production, YTIMESY_ENVIRONMENT: undefined }),
	).toBeNull();
});

function productionAuth() {
	for (const [name, value] of Object.entries(production))
		vi.stubEnv(name, value);
	return betterAuth({
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
		}),
		baseURL: appUrl,
		secret: "test-secret-with-at-least-32-characters-long",
		emailAndPassword: { enabled: true },
		plugins: authCaptchaPlugins(appUrl),
	});
}

function signUp(auth: ReturnType<typeof productionAuth>, token?: string) {
	return auth.handler(
		new Request(`${appUrl}/api/auth/sign-up/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: appUrl,
				...(token ? { "x-captcha-response": token } : {}),
			},
			body: JSON.stringify({
				email: "new@example.test",
				password: "correct-horse-battery",
				name: "New",
			}),
		}),
	);
}

it("refuses a production email sign-up without a Turnstile token", async () => {
	const verify = vi.fn();
	vi.stubGlobal("fetch", verify);
	const response = await signUp(productionAuth());
	expect(response.status).toBe(400);
	expect(verify).not.toHaveBeenCalled();
});

it("verifies the token server side and refuses a failed or foreign-host challenge", async () => {
	const verify = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(
				JSON.stringify({ success: false, "error-codes": ["invalid"] }),
				{ headers: { "content-type": "application/json" } },
			),
	);
	vi.stubGlobal("fetch", verify);
	const auth = productionAuth();
	expect((await signUp(auth, "forged")).status).toBe(403);
	const [url, init] = verify.mock.calls[0];
	expect(String(url)).toBe(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
	);
	expect(JSON.parse(String(init?.body))).toMatchObject({
		secret: production.TURNSTILE_SECRET_KEY,
		response: "forged",
	});
	verify.mockImplementationOnce(
		async () =>
			new Response(
				JSON.stringify({ success: true, hostname: "evil.example" }),
				{ headers: { "content-type": "application/json" } },
			),
	);
	expect((await signUp(auth, "other-site")).status).toBe(403);
});

it("lets a solved challenge through to sign-up", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ success: true, hostname: "app.example.test" }),
					{ headers: { "content-type": "application/json" } },
				),
		),
	);
	expect((await signUp(productionAuth(), "solved")).status).toBe(200);
});

it("Turnstile also guards resending the verification email", async () => {
	const { TURNSTILE_ENDPOINTS } = await import("./turnstile");
	expect(TURNSTILE_ENDPOINTS).toContain("/send-verification-email");
	expect(TURNSTILE_ENDPOINTS).toContain("/request-password-reset");
	expect(TURNSTILE_ENDPOINTS).toContain("/email-otp/send-verification-otp");
});
