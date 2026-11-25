/**
 * Referral rules: who may earn a reset of their usage window by inviting
 * someone, and when. Pure; the database work is in
 * src/server/adapters/referral.ts.
 */

/** The cookie that carries a personal code from the link to sign-up. */
export const REFERRAL_COOKIE = "yt_ref";
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const CODE_PATTERN = /^r-[a-z0-9]{8}$/;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** At most this many referrer rewards per rolling period, and in total. */
export const REFERRER_REWARDS_PER_PERIOD = 3;
export const REFERRER_PERIOD_DAYS = 30;
export const REFERRER_REWARDS_LIFETIME = 12;
/** A referrer's referrals decided within a day beyond this wait for the next day. */
export const REFERRER_DECISIONS_PER_DAY = 2;
/** Sign-ups from one network a day beyond this are held. */
export const NETWORK_SIGNUPS_PER_DAY = 3;
/** The delay between the referred person's first completed turn and the grant. */
export const GRANT_DELAY_MINUTES = 60;

export function parseReferralCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const code = value.trim().toLowerCase();
	return CODE_PATTERN.test(code) ? code : null;
}

/** A code from random bytes (one per character); the alphabet skips look-alikes. */
export function referralCodeFromBytes(bytes: Uint8Array): string {
	let suffix = "";
	for (let index = 0; index < 8; index++)
		suffix += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
	return `r-${suffix}`;
}

export function referralCookieValue(cookieHeader: string | null | undefined) {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const index = part.indexOf("=");
		if (index < 0 || part.slice(0, index).trim() !== REFERRAL_COOKIE) continue;
		return parseReferralCode(decodeURIComponent(part.slice(index + 1).trim()));
	}
	return null;
}

export function referralCookieString(code: string, secure: boolean) {
	return [
		`${REFERRAL_COOKIE}=${code}`,
		"Path=/",
		`Max-Age=${REFERRAL_COOKIE_MAX_AGE_SECONDS}`,
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

/** The code a page URL carries in `ref`, when it is a personal one. */
export function referralCodeFromUrl(url: URL) {
	return parseReferralCode(url.searchParams.get("ref"));
}

/** A code typed or pasted at sign-up: the bare code, or any link that carries it. */
export function referralCodeFromInput(text: string): string | null {
	const value = text.trim();
	const bare = parseReferralCode(value);
	if (bare) return bare;
	try {
		return referralCodeFromUrl(
			new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`),
		);
	} catch {
		return null;
	}
}

export function referralLink(origin: string, code: string) {
	return `${origin.replace(/\/$/, "")}/?ref=${code}`;
}

/** The friendly line that goes with the link wherever it is shared. */
export const REFERRAL_SHARE_TEXT =
	"I use ytimesy to work with coding agents on my repositories. Join with my link and get a fresh usage window:";

/** The X compose page with the text and the link: one place to share, beside copy and Share. */
export function postOnXUrl(link: string) {
	return `https://x.com/intent/post?text=${encodeURIComponent(REFERRAL_SHARE_TEXT)}&url=${encodeURIComponent(link)}`;
}

/**
 * The address as a mail provider sees it: lower case, no "+tag", and for
 * Gmail no dots (googlemail.com is gmail.com). Two spellings of one inbox
 * give one key.
 */
export function normalizeEmail(email: string): string {
	const [rawLocal, rawDomain = ""] = email.trim().toLowerCase().split("@");
	let domain = rawDomain;
	let local = rawLocal.split("+")[0];
	if (domain === "googlemail.com") domain = "gmail.com";
	if (domain === "gmail.com") local = local.replaceAll(".", "");
	return `${local}@${domain}`;
}

/** An IPv4 address as its /24, an IPv6 address as its /48; null when unreadable. */
export function networkPrefix(ip: string | null | undefined): string | null {
	const value = ip?.trim().toLowerCase();
	if (!value) return null;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value))
		return `${value.split(".").slice(0, 3).join(".")}.0/24`;
	if (value.includes(":")) {
		const groups = value.split("::")[0].split(":").filter(Boolean);
		return `${groups.slice(0, 3).join(":")}::/48`;
	}
	return null;
}

/** The browser family, coarse on purpose: enough to tell two machines apart, not to track one. */
export function userAgentFamily(userAgent: string | null | undefined) {
	const ua = userAgent ?? "";
	const browser = /Edg\//.test(ua)
		? "edge"
		: /Firefox\//.test(ua)
			? "firefox"
			: /Chrome\//.test(ua)
				? "chrome"
				: /Safari\//.test(ua)
					? "safari"
					: "other";
	const system = /Windows/.test(ua)
		? "windows"
		: /Android/.test(ua)
			? "android"
			: /iPhone|iPad/.test(ua)
				? "ios"
				: /Mac OS X/.test(ua)
					? "mac"
					: /Linux/.test(ua)
						? "linux"
						: "other";
	return `${browser}-${system}`;
}

export type ReferralFacts = {
	readonly enabled: boolean;
	readonly emailVerified: boolean;
	readonly referredEmailKey: string | null;
	readonly referrerEmailKey: string;
	/** Other referrals (any referrer) made with the same email key. */
	readonly otherReferralsWithEmailKey: number;
	/** The two accounts share a linked sign-in account (GitHub or Google id). */
	readonly sharedLinkedAccount: boolean;
	/** The referred sign-up network and device matches one of the referrer's recent sessions. */
	readonly networkMatch: boolean;
	readonly referrerRewardsInPeriod: number;
	readonly referrerRewardsLifetime: number;
	readonly referrerDecisionsToday: number;
};

export type ReferralDecision =
	| { readonly outcome: "wait"; readonly reason: string }
	| { readonly outcome: "block"; readonly reason: string }
	| { readonly outcome: "hold"; readonly reason: string }
	| {
			readonly outcome: "grant";
			/** False when the referrer reached a cap: the referred person is still rewarded. */
			readonly rewardReferrer: boolean;
			readonly reason: string;
	  };

/** What to do with a qualified referral whose delay has passed. Order matters: refusals first. */
export function decideReferral(facts: ReferralFacts): ReferralDecision {
	if (!facts.enabled) return { outcome: "wait", reason: "disabled" };
	if (!facts.emailVerified)
		return { outcome: "wait", reason: "unverified_email" };
	if (facts.referredEmailKey === facts.referrerEmailKey)
		return { outcome: "block", reason: "same_email" };
	if (facts.otherReferralsWithEmailKey > 0)
		return { outcome: "block", reason: "duplicate_email" };
	if (facts.sharedLinkedAccount)
		return { outcome: "block", reason: "shared_linked_account" };
	if (facts.networkMatch) return { outcome: "hold", reason: "same_network" };
	if (facts.referrerDecisionsToday >= REFERRER_DECISIONS_PER_DAY)
		return { outcome: "wait", reason: "referrer_daily_limit" };
	const capped =
		facts.referrerRewardsInPeriod >= REFERRER_REWARDS_PER_PERIOD ||
		facts.referrerRewardsLifetime >= REFERRER_REWARDS_LIFETIME;
	return capped
		? { outcome: "grant", rewardReferrer: false, reason: "referrer_capped" }
		: { outcome: "grant", rewardReferrer: true, reason: "granted" };
}
