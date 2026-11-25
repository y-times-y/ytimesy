import {
	parseReferralCode,
	referralCodeFromUrl,
	referralCookieString,
	referralCookieValue,
} from "#/domain/referral";
import {
	firstTouchCookieString,
	firstTouchFromPage,
	isBotUserAgent,
	readFirstTouchCookie,
	urlWithoutAttribution,
} from "#/domain/referral-attribution";

type FirstTouchWindow = Pick<Window, "location" | "history" | "document"> & {
	readonly navigator: Pick<Navigator, "userAgent" | "webdriver"> & {
		readonly doNotTrack?: string | null;
		readonly globalPrivacyControl?: boolean;
	};
};

/**
 * Runs once after hydration (never before the first paint, never on the
 * server). Records where this visitor first came from in a first-party cookie
 * the server reads at sign-up, unless one is already set (first touch wins),
 * and then removes `ref`/`utm_*` from the address bar without a navigation.
 *
 * Nothing is stored for bots and automation, under Do Not Track or Global
 * Privacy Control, or for visitors in the EU, EEA, UK or Switzerland
 * (privacy-region.ts), where this non-essential cookie would need consent.
 */
export function captureFirstTouch(
	options: { readonly strictRegion: boolean },
	win: FirstTouchWindow = window,
	now: Date = new Date(),
) {
	try {
		const url = new URL(win.location.href);
		const nav = win.navigator;
		const allowed =
			!options.strictRegion &&
			!nav.webdriver &&
			!isBotUserAgent(nav.userAgent) &&
			nav.doNotTrack !== "1" &&
			nav.globalPrivacyControl !== true;
		if (allowed && !readFirstTouchCookie(win.document.cookie, url.hostname))
			win.document.cookie = firstTouchCookieString(
				firstTouchFromPage({ url, referrer: win.document.referrer, now }),
				url.protocol === "https:",
			);
		const clean = urlWithoutAttribution(url);
		// The router's own history state (its entry key) is kept as it is.
		if (clean) win.history.replaceState(win.history.state, "", clean);
	} catch {
		// Attribution is best effort; it must never break a page.
	}
}

const REFERRAL_STORAGE_KEY = "ytimesy:referral-code";

type ReferralWindow = FirstTouchWindow & {
	readonly localStorage?: Pick<Storage, "getItem" | "setItem">;
};

/**
 * Keeps a personal code until sign-up: in the first-party `yt_ref` cookie,
 * which the server reads when the account is created, and in local storage,
 * which restores the cookie if it is cleared before then. Used by the link
 * (captureReferralCode) and by the code field on the sign-in screens.
 */
export function saveReferralCode(code: string, win: ReferralWindow = window) {
	try {
		win.document.cookie = referralCookieString(
			code,
			new URL(win.location.href).protocol === "https:",
		);
		win.localStorage?.setItem(REFERRAL_STORAGE_KEY, code);
	} catch {
		// Attribution is best effort; it must never break a page.
	}
}

/** The code this browser holds for the next sign-up, if any. */
export function savedReferralCode(win: ReferralWindow = window) {
	try {
		return (
			referralCookieValue(win.document.cookie) ??
			parseReferralCode(win.localStorage?.getItem(REFERRAL_STORAGE_KEY))
		);
	} catch {
		return null;
	}
}

/**
 * Keeps a personal referral code from the address (`?ref=r-xxxxxxxx`), from
 * whatever page or message the link was shared in. It is the visitor's own
 * request to be credited to the person who invited them, so unlike the
 * first-touch cookie it is not held back for Do Not Track or the opt-in
 * regions. Not set for bots and automation. Without a code in the address it
 * restores the cookie from local storage when the cookie is gone. Run before
 * captureFirstTouch, which removes `ref` from the address bar. The latest
 * link wins.
 */
export function captureReferralCode(win: ReferralWindow = window) {
	try {
		const nav = win.navigator;
		if (nav.webdriver || isBotUserAgent(nav.userAgent)) return;
		const code = referralCodeFromUrl(new URL(win.location.href));
		if (code) saveReferralCode(code, win);
		else {
			const saved = savedReferralCode(win);
			if (saved && !referralCookieValue(win.document.cookie))
				saveReferralCode(saved, win);
		}
	} catch {
		// Attribution is best effort; it must never break a page.
	}
}

/** The visitor's first-touch `ref` and `utm_source`, for the app_viewed event. */
export function firstTouchEventProperties(
	cookie: string = typeof document === "undefined" ? "" : document.cookie,
) {
	const touch = readFirstTouchCookie(cookie);
	return {
		...(touch?.ref ? { initial_ref: touch.ref } : {}),
		...(touch?.utm_source ? { initial_utm_source: touch.utm_source } : {}),
	};
}
