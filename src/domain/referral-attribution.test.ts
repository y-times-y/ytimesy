import { describe, expect, it } from "vitest";
import {
	FIRST_TOUCH_COOKIE,
	firstTouchCookieString,
	firstTouchFromPage,
	initialAttributionProperties,
	isBotUserAgent,
	readFirstTouchCookie,
	sanitizeFirstTouch,
	sanitizeLandingPath,
	sanitizeRef,
	sanitizeReferrerHost,
	sanitizeUtm,
	serializeFirstTouch,
	urlWithoutAttribution,
} from "./referral-attribution";

const now = new Date("2026-11-02T18:00:00.000Z");

describe("parsing a landing page", () => {
	it("reads ref, utm_*, the referrer host and the landing path", () => {
		const touch = firstTouchFromPage({
			url: new URL(
				"https://ytimesy.com/blog/harness-1-0?ref=X&utm_source=Twitter&utm_medium=social&utm_campaign=Launch%20Week&utm_content=thread&utm_term=agents&tab=1#top",
			),
			referrer: "https://www.t.co/abc?x=1",
			now,
		});
		expect(touch).toEqual({
			ref: "x",
			utm_source: "twitter",
			utm_medium: "social",
			utm_campaign: "launch_week",
			utm_content: "thread",
			utm_term: "agents",
			referrer_host: "t.co",
			landing_path: "/blog/harness-1-0",
			at: now.toISOString(),
		});
	});

	it("records a direct visit too, so a later tagged visit cannot claim it", () => {
		expect(
			firstTouchFromPage({
				url: new URL("https://ytimesy.com/"),
				referrer: "",
				now,
			}),
		).toEqual({ landing_path: "/", at: now.toISOString() });
	});

	it("ignores our own host as a referrer", () => {
		const touch = firstTouchFromPage({
			url: new URL("https://ytimesy.com/auth/sign-up"),
			referrer: "https://ytimesy.com/",
			now,
		});
		expect(touch.referrer_host).toBeUndefined();
		expect(
			sanitizeReferrerHost("https://dev.ytimesy.com/", "ytimesy.com"),
		).toBe(undefined);
	});
});

describe("sanitizing", () => {
	it("keeps ref to [a-z0-9_-], at most 32 characters", () => {
		expect(sanitizeRef(" HackerNews ")).toBe("hackernews");
		expect(sanitizeRef("product_hunt-1")).toBe("product_hunt-1");
		expect(sanitizeRef("<script>")).toBeUndefined();
		expect(sanitizeRef("a b")).toBeUndefined();
		expect(sanitizeRef("x".repeat(33))).toBeUndefined();
		expect(sanitizeRef(42)).toBeUndefined();
		expect(sanitizeRef("")).toBeUndefined();
	});

	it("bounds UTM values and replaces unsafe characters", () => {
		expect(sanitizeUtm("Spring Sale!!")).toBe("spring_sale");
		expect(sanitizeUtm('"><img src=x>')).toBe("img_src_x");
		expect(sanitizeUtm("a".repeat(200))).toHaveLength(64);
		expect(sanitizeUtm("   ")).toBeUndefined();
	});

	it("keeps only a valid host from a referrer and only a path from a landing URL", () => {
		expect(sanitizeReferrerHost("https://news.ycombinator.com/item?id=1")).toBe(
			"news.ycombinator.com",
		);
		// An Android app referrer keeps its package name.
		expect(sanitizeReferrerHost("android-app://com.slack/")).toBe("com.slack");
		expect(sanitizeReferrerHost("https://localhost:3000/")).toBeUndefined();
		expect(sanitizeReferrerHost("not a url")).toBeUndefined();
		expect(sanitizeLandingPath("/blog?ref=x#a")).toBe("/blog");
		expect(sanitizeLandingPath(`/${"a".repeat(300)}`)).toHaveLength(120);
		expect(sanitizeLandingPath("https://evil.example/")).toBeUndefined();
	});

	it("re-sanitizes an untrusted cookie and drops unknown keys", () => {
		expect(
			sanitizeFirstTouch({
				ref: "x",
				utm_source: "A B",
				email: "a@b.c",
				at: "2026-11-01T00:00:00Z",
			}),
		).toEqual({ ref: "x", utm_source: "a_b", at: "2026-11-01T00:00:00.000Z" });
		expect(sanitizeFirstTouch({ ref: "x" })).toBeNull();
		expect(sanitizeFirstTouch(["x"])).toBeNull();
	});
});

describe("the cookie", () => {
	it("round-trips through a Cookie header among other cookies", () => {
		const touch = { ref: "linkedin", landing_path: "/", at: now.toISOString() };
		const header = `a=1; ${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(touch)}; b=2`;
		expect(readFirstTouchCookie(header)).toEqual(touch);
		expect(readFirstTouchCookie("a=1")).toBeNull();
		expect(readFirstTouchCookie(`${FIRST_TOUCH_COOKIE}=%7Bbroken`)).toBeNull();
		expect(readFirstTouchCookie(null)).toBeNull();
	});

	it("lasts about 90 days, is Lax, and Secure on https", () => {
		const cookie = firstTouchCookieString({ at: now.toISOString() }, true);
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Secure");
		expect(cookie).not.toContain("HttpOnly");
		expect(
			firstTouchCookieString({ at: now.toISOString() }, false),
		).not.toContain("Secure");
	});
});

describe("URL cleanup", () => {
	it("removes ref and utm_* but keeps other query parameters and the hash", () => {
		expect(
			urlWithoutAttribution(
				new URL(
					"https://ytimesy.com/blog/harness-1-0?ref=x&utm_source=y&page=2#intro",
				),
			),
		).toBe("/blog/harness-1-0?page=2#intro");
		expect(urlWithoutAttribution(new URL("https://ytimesy.com/?ref=x"))).toBe(
			"/",
		);
	});

	it("leaves a URL without attribution alone", () => {
		expect(
			urlWithoutAttribution(new URL("https://ytimesy.com/?page=2")),
		).toBeNull();
	});
});

it("treats crawlers, unfurlers and missing user agents as bots", () => {
	expect(
		isBotUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)"),
	).toBe(true);
	expect(isBotUserAgent("Twitterbot/1.0")).toBe(true);
	expect(isBotUserAgent("Mozilla/5.0 HeadlessChrome/120")).toBe(true);
	expect(isBotUserAgent("")).toBe(true);
	expect(
		isBotUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		),
	).toBe(false);
});

it("names PostHog person properties initial_*", () => {
	expect(
		initialAttributionProperties({
			ref: "x",
			utm_source: "twitter",
			referrer_host: "t.co",
			at: now.toISOString(),
		}),
	).toEqual({
		initial_ref: "x",
		initial_utm_source: "twitter",
		initial_referrer_host: "t.co",
	});
	expect(initialAttributionProperties(null)).toEqual({});
});
