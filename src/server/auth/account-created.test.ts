import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	record: vi.fn(async (_userId: string, _source: string) => undefined),
	recordAtSignIn: vi.fn(async (_userId: string) => undefined),
	capture: vi.fn(async (..._args: unknown[]) => undefined),
	attribution: vi.fn(async (_userId: string, _touch: unknown) => undefined),
}));
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
