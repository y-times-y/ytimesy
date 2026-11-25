import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	record: vi.fn(async (_userId: string, _source: string) => undefined),
	recordAtSignIn: vi.fn(async (_userId: string) => undefined),
	capture: vi.fn(async (..._args: unknown[]) => undefined),
	attribution: vi.fn(async (_userId: string, _touch: unknown) => undefined),
	referral: vi.fn(async (_input: unknown) => "attributed"),
}));
vi.mock("../adapters/referral", () => ({ attributeReferral: mocks.referral }));
vi.mock("../adapters/user-attribution", () => ({
	recordUserAttribution: mocks.attribution,
}));
vi.mock("../adapters/legal-acceptance", () => ({
	recordLegalAcceptance: mocks.record,
	recordLegalAcceptanceAtSignIn: mocks.recordAtSignIn,
}));
vi.mock("../adapters/analytics", () => ({
	captureServerAnalytics: mocks.capture,
}));
vi.mock("../adapters/database", () => ({ database: () => ({}) }));

import {
	FIRST_TOUCH_COOKIE,
	serializeFirstTouch,
} from "#/domain/referral-attribution";
import { accountCreated, signedIn } from "./auth";

const CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const touch = {
	ref: "x",
	utm_source: "twitter",
	referrer_host: "t.co",
	landing_path: "/blog/harness-1-0",
	at: "2026-11-01T00:00:00.000Z",
};
const cookie = `other=1; ${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(touch)}`;

it("records Terms and Privacy acceptance for every new account", async () => {
	const createdAt = new Date();
	await accountCreated({ id: "new-user", createdAt });
	expect(mocks.record).toHaveBeenCalledWith("new-user", "signup");
	expect(mocks.capture).toHaveBeenCalledWith(
		"new-user",
		"account_created",
		{},
		{ key: "new-user", timestamp: createdAt, setOnce: {} },
	);
	expect(mocks.attribution).not.toHaveBeenCalled();
});

it.each([
	["email sign-up", { headers: new Headers({ cookie, "user-agent": CHROME }) }],
	[
		"a GitHub or Google callback",
		{
			request: new Request("https://ytimesy.com/api/auth/callback/github", {
				headers: { cookie, "user-agent": CHROME },
			}),
		},
	],
])(
	"saves the first touch on the account at %s and sends it to PostHog once",
	async (_, context) => {
		mocks.attribution.mockClear();
		mocks.capture.mockClear();
		const createdAt = new Date();
		await accountCreated({ id: "referred", createdAt }, context);
		expect(mocks.attribution).toHaveBeenCalledWith("referred", touch);
		const initial = {
			initial_ref: "x",
			initial_utm_source: "twitter",
			initial_referrer_host: "t.co",
			initial_landing_path: "/blog/harness-1-0",
		};
		expect(mocks.capture).toHaveBeenCalledWith(
			"referred",
			"account_created",
			initial,
			{ key: "referred", timestamp: createdAt, setOnce: initial },
		);
	},
);

it("saves no attribution for a bot or without the cookie, and never fails sign-up on it", async () => {
	mocks.attribution.mockClear();
	await accountCreated(
		{ id: "bot", createdAt: new Date() },
		{ headers: new Headers({ cookie, "user-agent": "curl/8.0" }) },
	);
	await accountCreated(
		{ id: "plain", createdAt: new Date() },
		{ headers: new Headers({ "user-agent": CHROME }) },
	);
	expect(mocks.attribution).not.toHaveBeenCalled();
	mocks.attribution.mockRejectedValueOnce(new Error("database down"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await expect(
		accountCreated(
			{ id: "u4", createdAt: new Date() },
			{ headers: new Headers({ cookie, "user-agent": CHROME }) },
		),
	).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});

it("does not fail sign-up when the acceptance write fails", async () => {
	mocks.record.mockRejectedValueOnce(new Error("database down"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await expect(
		accountCreated({ id: "u2", createdAt: new Date() }),
	).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});

it("records acceptance of the current versions at every sign-in", async () => {
	await signedIn({ userId: "returning" });
	expect(mocks.recordAtSignIn).toHaveBeenCalledWith("returning");
	mocks.recordAtSignIn.mockRejectedValueOnce(new Error("database down"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await expect(signedIn({ userId: "u3" })).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});

it("attributes a sign-up that came through a referral link, with the network and browser", async () => {
	mocks.referral.mockClear();
	const headers = new Headers({
		cookie: "yt_ref=r-k3f9x2qa",
		"user-agent": CHROME,
		"cf-connecting-ip": "203.0.113.9",
	});
	await accountCreated(
		{ id: "joined", email: "joined@example.test", createdAt: new Date() },
		{ headers },
	);
	expect(mocks.referral).toHaveBeenCalledWith({
		userId: "joined",
		email: "joined@example.test",
		code: "r-k3f9x2qa",
		ip: "203.0.113.9",
		userAgent: CHROME,
	});
});

it("ignores a bad code, a bot and a missing email, and never fails sign-up on a referral error", async () => {
	mocks.referral.mockClear();
	const user = { id: "u5", email: "u5@example.test", createdAt: new Date() };
	await accountCreated(user, {
		headers: new Headers({ cookie: "yt_ref=hn", "user-agent": CHROME }),
	});
	await accountCreated(user, {
		headers: new Headers({
			cookie: "yt_ref=r-k3f9x2qa",
			"user-agent": "curl/8.0",
		}),
	});
	await accountCreated(
		{ id: "u6", createdAt: new Date() },
		{
			headers: new Headers({
				cookie: "yt_ref=r-k3f9x2qa",
				"user-agent": CHROME,
			}),
		},
	);
	expect(mocks.referral).not.toHaveBeenCalled();
	mocks.referral.mockRejectedValueOnce(new Error("database down"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await expect(
		accountCreated(user, {
			headers: new Headers({
				cookie: "yt_ref=r-k3f9x2qa",
				"user-agent": CHROME,
			}),
		}),
	).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});

it.each([
	["email sign-up (code step follows)", (headers: Headers) => ({ headers })],
	[
		"a GitHub callback",
		(headers: Headers) => ({
			request: new Request("https://ytimesy.com/api/auth/callback/github", {
				headers,
			}),
		}),
	],
	[
		"a Google callback",
		(headers: Headers) => ({
			request: new Request("https://ytimesy.com/api/auth/callback/google", {
				headers,
			}),
		}),
	],
])("attributes the referral at %s", async (_, context) => {
	mocks.referral.mockClear();
	const headers = new Headers({
		cookie: "other=1; yt_ref=r-k3f9x2qa",
		"user-agent": CHROME,
	});
	await accountCreated(
		{ id: "any-method", email: "any@example.test", createdAt: new Date() },
		context(headers),
	);
	expect(mocks.referral).toHaveBeenCalledWith(
		expect.objectContaining({ userId: "any-method", code: "r-k3f9x2qa" }),
	);
});
