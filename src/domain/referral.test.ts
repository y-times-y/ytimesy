import { describe, expect, it } from "vitest";
import {
	decideReferral,
	networkPrefix,
	normalizeEmail,
	parseReferralCode,
	postOnXUrl,
	type ReferralFacts,
	referralCodeFromBytes,
	referralCodeFromInput,
	referralCodeFromUrl,
	referralCookieString,
	referralCookieValue,
	referralLink,
	userAgentFamily,
} from "./referral";

const facts: ReferralFacts = {
	enabled: true,
	emailVerified: true,
	referredEmailKey: "new@example.test",
	referrerEmailKey: "old@example.test",
	otherReferralsWithEmailKey: 0,
	sharedLinkedAccount: false,
	networkMatch: false,
	referrerRewardsInPeriod: 0,
	referrerRewardsLifetime: 0,
	referrerDecisionsToday: 0,
};

describe("referral codes and links", () => {
	it("accepts only personal codes", () => {
		expect(parseReferralCode(" R-K3F9X2QA ")).toBe("r-k3f9x2qa");
		for (const bad of ["hn", "r-short", "r-k3f9x2qa9", "r-k3f9x2q!", null, 4])
			expect(parseReferralCode(bad)).toBeNull();
	});
	it("makes a code from bytes and reads it from a URL and a cookie", () => {
		const code = referralCodeFromBytes(
			Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 255]),
		);
		expect(parseReferralCode(code)).toBe(code);
		expect(
			referralCodeFromUrl(new URL(`https://ytimesy.com/?ref=${code}`)),
		).toBe(code);
		expect(
			referralCodeFromUrl(new URL("https://ytimesy.com/?ref=hn")),
		).toBeNull();
		const cookie = referralCookieString(code, true);
		expect(cookie).toContain("Secure");
		expect(referralCookieValue(`a=1; ${cookie.split(";")[0]}`)).toBe(code);
		expect(referralCookieValue("yt_ref=<script>")).toBeNull();
	});
	it("builds the share link and the X compose link", () => {
		const link = referralLink("https://ytimesy.com/", "r-k3f9x2qa");
		expect(link).toBe("https://ytimesy.com/?ref=r-k3f9x2qa");
		const url = new URL(postOnXUrl(link));
		expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
		expect(url.searchParams.get("url")).toBe(link);
		expect(url.searchParams.get("text")).not.toMatch(/\d/);
	});
});

describe("same-inbox and same-network keys", () => {
	it("gives one key to every spelling of one inbox", () => {
		const keys = [
			"Jane.Doe+work@Gmail.com",
			"janedoe@gmail.com",
			"j.a.n.e.d.o.e@googlemail.com",
		].map(normalizeEmail);
		expect(new Set(keys)).toEqual(new Set(["janedoe@gmail.com"]));
		expect(normalizeEmail("a.b+x@example.test")).toBe("a.b@example.test");
	});
	it("coarsens addresses and browsers", () => {
		expect(networkPrefix("203.0.113.77")).toBe("203.0.113.0/24");
		expect(networkPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
		expect(networkPrefix("nonsense")).toBeNull();
		expect(
			userAgentFamily(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537",
			),
		).toBe("chrome-mac");
	});
});

describe("decideReferral", () => {
	it("grants a clean referral to both", () => {
		expect(decideReferral(facts)).toEqual({
			outcome: "grant",
			rewardReferrer: true,
			reason: "granted",
		});
	});
	it("waits when switched off or unverified", () => {
		expect(decideReferral({ ...facts, enabled: false }).outcome).toBe("wait");
		expect(decideReferral({ ...facts, emailVerified: false }).outcome).toBe(
			"wait",
		);
	});
	it("blocks the same inbox, a reused inbox and a shared linked account", () => {
		expect(
			decideReferral({ ...facts, referredEmailKey: facts.referrerEmailKey }),
		).toEqual({ outcome: "block", reason: "same_email" });
		expect(
			decideReferral({ ...facts, otherReferralsWithEmailKey: 1 }).outcome,
		).toBe("block");
		expect(
			decideReferral({ ...facts, sharedLinkedAccount: true }).outcome,
		).toBe("block");
	});
	it("holds, not rewards, a sign-up from the referrer's network", () => {
		expect(decideReferral({ ...facts, networkMatch: true })).toEqual({
			outcome: "hold",
			reason: "same_network",
		});
	});
	it("caps the referrer but still rewards the referred person", () => {
		expect(
			decideReferral({ ...facts, referrerRewardsInPeriod: 3 }),
		).toMatchObject({ outcome: "grant", rewardReferrer: false });
		expect(
			decideReferral({ ...facts, referrerRewardsLifetime: 12 }),
		).toMatchObject({ rewardReferrer: false });
		expect(
			decideReferral({ ...facts, referrerRewardsInPeriod: 2 }),
		).toMatchObject({ rewardReferrer: true });
	});
	it("spreads a referrer's decisions over days", () => {
		expect(decideReferral({ ...facts, referrerDecisionsToday: 2 })).toEqual({
			outcome: "wait",
			reason: "referrer_daily_limit",
		});
	});
});

describe("referralCodeFromInput", () => {
	it("takes a bare code or any link that carries one", () => {
		for (const text of [
			"r-k3f9x2qa",
			"  R-K3F9X2QA  ",
			"https://ytimesy.com/?ref=r-k3f9x2qa",
			"ytimesy.com/?ref=r-k3f9x2qa&utm_source=chat",
		])
			expect(referralCodeFromInput(text)).toBe("r-k3f9x2qa");
	});
	it("refuses anything else", () => {
		for (const text of ["", "hello", "https://ytimesy.com/?ref=hn", "r-short"])
			expect(referralCodeFromInput(text)).toBeNull();
	});
});
