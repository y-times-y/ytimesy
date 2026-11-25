import { describe, expect, it, vi } from "vitest";
import {
	FIRST_TOUCH_COOKIE,
	readFirstTouchCookie,
	serializeFirstTouch,
} from "#/domain/referral-attribution";
import {
	captureFirstTouch,
	captureReferralCode,
	firstTouchEventProperties,
	savedReferralCode,
	saveReferralCode,
} from "./first-touch";

const CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function fakeWindow(
	href: string,
	options: {
		cookie?: string;
		referrer?: string;
		userAgent?: string;
		webdriver?: boolean;
		doNotTrack?: string;
		globalPrivacyControl?: boolean;
	} = {},
) {
	const jar = new Map<string, string>();
	if (options.cookie) {
		const [name, ...value] = options.cookie.split("=");
		jar.set(name, value.join("="));
	}
	const writes: string[] = [];
	const state = { __TSR_key: "k1" };
	const replaceState = vi.fn();
	const document = {
		referrer: options.referrer ?? "",
		get cookie() {
			return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		},
		set cookie(value: string) {
			writes.push(value);
			const pair = value.split(";", 1)[0];
			const index = pair.indexOf("=");
			jar.set(pair.slice(0, index), pair.slice(index + 1));
		},
	};
	const win = {
		location: { href },
		history: { state, replaceState },
		document,
		navigator: {
			userAgent: options.userAgent ?? CHROME,
			webdriver: options.webdriver ?? false,
			doNotTrack: options.doNotTrack ?? null,
			globalPrivacyControl: options.globalPrivacyControl,
		},
	} as unknown as Parameters<typeof captureFirstTouch>[1];
	return { win, writes, replaceState, state, document };
}

const now = new Date("2026-11-02T18:00:00.000Z");

describe("captureFirstTouch", () => {
	it("stores the first touch and strips ref/utm_* without a navigation", () => {
		const page = fakeWindow(
			"https://ytimesy.com/blog/harness-1-0?ref=x&utm_source=twitter&page=2#intro",
			{ referrer: "https://t.co/abc" },
		);
		captureFirstTouch({ strictRegion: false }, page.win, now);
		expect(page.writes).toHaveLength(1);
		expect(page.writes[0]).toContain("SameSite=Lax");
		expect(page.writes[0]).toContain("Secure");
		expect(readFirstTouchCookie(page.document.cookie)).toEqual({
			ref: "x",
			utm_source: "twitter",
			referrer_host: "t.co",
			landing_path: "/blog/harness-1-0",
			at: now.toISOString(),
		});
		expect(page.replaceState).toHaveBeenCalledWith(
			page.state,
			"",
			"/blog/harness-1-0?page=2#intro",
		);
	});

	it("keeps the first touch: a later tagged visit does not overwrite it", () => {
		const first = {
			ref: "hackernews",
			landing_path: "/",
			at: "2026-10-01T00:00:00.000Z",
		};
		const page = fakeWindow("https://ytimesy.com/?ref=x", {
			cookie: `${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(first)}`,
		});
		captureFirstTouch({ strictRegion: false }, page.win, now);
		expect(page.writes).toHaveLength(0);
		expect(readFirstTouchCookie(page.document.cookie)).toEqual(first);
		// The address bar is still cleaned.
		expect(page.replaceState).toHaveBeenCalledWith(page.state, "", "/");
	});

	it("does not touch the URL when it has no attribution", () => {
		const page = fakeWindow("https://ytimesy.com/blog?page=2");
		captureFirstTouch({ strictRegion: false }, page.win, now);
		expect(page.replaceState).not.toHaveBeenCalled();
		expect(page.writes).toHaveLength(1);
	});

	it.each([
		["a bot", { userAgent: "Twitterbot/1.0" }, false],
		["automation", { webdriver: true }, false],
		["Do Not Track", { doNotTrack: "1" }, false],
		["Global Privacy Control", { globalPrivacyControl: true }, false],
		["the EU/UK", {}, true],
	] as const)(
		"stores nothing for %s, but still cleans the URL",
		(_, options, strictRegion) => {
			const page = fakeWindow("https://ytimesy.com/?ref=x", options);
			captureFirstTouch({ strictRegion }, page.win, now);
			expect(page.writes).toHaveLength(0);
			expect(page.replaceState).toHaveBeenCalledWith(page.state, "", "/");
		},
	);

	it("never throws", () => {
		const page = fakeWindow("not a url");
		expect(() =>
			captureFirstTouch({ strictRegion: false }, page.win, now),
		).not.toThrow();
	});
});

it("adds the first-touch ref and source to app_viewed", () => {
	const touch = {
		ref: "x",
		utm_source: "twitter",
		utm_medium: "social",
		at: now.toISOString(),
	};
	expect(
		firstTouchEventProperties(
			`${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(touch)}`,
		),
	).toEqual({ initial_ref: "x", initial_utm_source: "twitter" });
	expect(firstTouchEventProperties("")).toEqual({});
});

describe("captureReferralCode", () => {
	const link = "https://ytimesy.com/?ref=r-k3f9x2qa";
	it("keeps a personal code even under Do Not Track and in opt-in regions", () => {
		const { win, writes } = fakeWindow(link, { doNotTrack: "1" });
		captureReferralCode(win);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatch(
			/^yt_ref=r-k3f9x2qa; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/,
		);
	});
	it("ignores platform refs, bots and automation", () => {
		for (const options of [
			{},
			{ webdriver: true },
			{ userAgent: "Googlebot/2.1" },
		]) {
			const target =
				options.webdriver || options.userAgent
					? link
					: "https://ytimesy.com/?ref=hn";
			const { win, writes } = fakeWindow(target, options);
			captureReferralCode(win);
			expect(writes).toHaveLength(0);
		}
	});
});

describe("referral code storage", () => {
	const link = "https://ytimesy.com/?ref=r-k3f9x2qa";
	function withStorage(
		win: ReturnType<typeof fakeWindow>["win"],
		initial?: string,
	) {
		const store = new Map<string, string>(
			initial ? [["ytimesy:referral-code", initial]] : [],
		);
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		};
		return Object.assign({ ...win }, {
			localStorage: storage,
		}) as unknown as Parameters<typeof captureReferralCode>[0] & {
			localStorage: typeof storage;
		};
	}
	it("keeps a code from a link in the cookie and in local storage", () => {
		const page = fakeWindow(link);
		const win = withStorage(page.win);
		captureReferralCode(win);
		expect(savedReferralCode(win)).toBe("r-k3f9x2qa");
		expect(win.localStorage.getItem("ytimesy:referral-code")).toBe(
			"r-k3f9x2qa",
		);
	});
	it("restores the cookie from local storage when it was cleared before sign-up", () => {
		const page = fakeWindow("https://ytimesy.com/auth/sign-up");
		const win = withStorage(page.win, "r-k3f9x2qa");
		captureReferralCode(win);
		expect(page.writes[0]).toMatch(/^yt_ref=r-k3f9x2qa;/);
	});
	it("keeps a code typed at sign-up like one from a link", () => {
		const page = fakeWindow("https://ytimesy.com/auth/sign-up");
		const win = withStorage(page.win);
		expect(savedReferralCode(win)).toBeNull();
		saveReferralCode("r-k3f9x2qa", win);
		expect(page.writes[0]).toMatch(/^yt_ref=r-k3f9x2qa;/);
		expect(savedReferralCode(win)).toBe("r-k3f9x2qa");
	});
	it("a newer link replaces the earlier code", () => {
		const page = fakeWindow("https://ytimesy.com/?ref=r-bbbbbbbb");
		const win = withStorage(page.win, "r-aaaaaaaa");
		captureReferralCode(win);
		expect(savedReferralCode(win)).toBe("r-bbbbbbbb");
	});
});
