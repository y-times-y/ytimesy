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
