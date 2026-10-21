import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalOriginRedirect } from "../web/canonical-origin";
import { oauthAccountPolicy } from "./auth";

vi.mock("../adapters/database", () => ({ database: () => ({}) }));

const appUrl = "http://localhost:3000";

function testAuth() {
	return betterAuth({
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
		}),
		baseURL: appUrl,
		secret: "test-secret-with-at-least-32-characters-long",
		socialProviders: {
			github: { clientId: "client", clientSecret: "secret" },
		},
		account: oauthAccountPolicy,
		onAPIError: { errorURL: `${appUrl}/auth/sign-in` },
	});
}

async function startSignIn(auth: ReturnType<typeof testAuth>) {
	const response = await auth.handler(
		new Request(`${appUrl}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: appUrl },
			body: JSON.stringify({ provider: "github", callbackURL: "/" }),
		}),
	);
	const { url } = (await response.json()) as { url: string };
	const state = new URL(url).searchParams.get("state");
	const cookie = (response.headers.getSetCookie?.() ?? [])
		.map((value) => value.split(";")[0])
		.join("; ");
	if (!state) throw new Error("sign-in returned no state");
	return { state, cookie };
}

function callback(
	auth: ReturnType<typeof testAuth>,
	state: string,
	cookie?: string,
) {
	return auth.handler(
		new Request(
			`${appUrl}/api/auth/callback/github?code=attacker-code&state=${state}`,
			{ headers: cookie ? { cookie } : {} },
		),
	);
}

afterEach(() => vi.unstubAllGlobals());

it("never skips the browser-bound state cookie check", () => {
	expect(oauthAccountPolicy).not.toHaveProperty("skipStateCookieCheck");
	expect(oauthAccountPolicy.storeStateStrategy).toBe("database");
});

it("rejects an OAuth callback whose state is not bound to this browser", async () => {
	const auth = testAuth();
	// The attacker starts a sign-in in their own browser and forwards the
	// callback URL (state + their code) to the victim, who has no state cookie.
	const { state } = await startSignIn(auth);
	const providerCalls = vi.fn();
	vi.stubGlobal("fetch", providerCalls);
	const response = await callback(auth, state);
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toContain("error=state_mismatch");
	expect(response.headers.getSetCookie?.().join(";") ?? "").not.toMatch(
		/session_token=[^;]/,
	);
	expect(providerCalls).not.toHaveBeenCalled();
});

it("accepts the state in the browser that started the sign-in", async () => {
	const auth = testAuth();
	const { state, cookie } = await startSignIn(auth);
	expect(cookie).toContain("state=");
	// The code exchange is reached (state passed); the provider refuses the code.
	const providerCalls = vi.fn(
		async () =>
			new Response(JSON.stringify({ error: "bad_verification_code" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", providerCalls);
	const response = await callback(auth, state, cookie);
	expect(response.headers.get("location") ?? "").not.toContain(
		"state_mismatch",
	);
	expect(providerCalls).toHaveBeenCalled();
});

it("sends the loopback alias to the APP_URL host before any cookie is set", () => {
	const redirect = canonicalOriginRedirect(
		new Request("http://127.0.0.1:3000/auth/sign-in?x=1"),
		appUrl,
	);
	expect(redirect?.status).toBe(307);
	expect(redirect?.headers.get("location")).toBe(
		"http://localhost:3000/auth/sign-in?x=1",
	);
	expect(
		canonicalOriginRedirect(new Request("http://localhost:3000/"), appUrl),
	).toBeNull();
	expect(
		canonicalOriginRedirect(new Request("https://evil.example/"), appUrl),
	).toBeNull();
	expect(
		canonicalOriginRedirect(
			new Request("http://127.0.0.1:3000/api/x", { method: "POST" }),
			appUrl,
		),
	).toBeNull();
});
