import { expect, it } from "vitest";
import { consentBannerCopy, consentBannerVisible } from "./consent-banner";
import { consentTier } from "./consent-tier";
import { replayBrowserBlock, replayRecords } from "./replay-choice";
import {
	replaySwitchOn,
	replayUnavailableReason,
} from "./replay-choice-setting";

it("records only when allowed, unblocked and not declined", () => {
	for (const allowed of [true, false])
		for (const block of [
			null,
			"do-not-track",
			"global-privacy-control",
		] as const)
			for (const choice of [null, "allowed", "declined"] as const) {
				const open = allowed && block === null;
				expect(replayRecords({ allowed, block, choice })).toBe(
					open && choice !== "declined",
				);
				// Where consent comes first, only an Accept records.
				expect(
					replayRecords({ allowed, block, choice, consentRequired: true }),
				).toBe(open && choice === "allowed");
			}
});

it("reads Do Not Track and Global Privacy Control", () => {
	expect(replayBrowserBlock({ doNotTrack: "1" })).toBe("do-not-track");
	expect(
		replayBrowserBlock({ doNotTrack: null, globalPrivacyControl: true }),
	).toBe("global-privacy-control");
	expect(replayBrowserBlock({ doNotTrack: "0" })).toBeNull();
});

it("says why analytics is off instead of offering a switch", () => {
	expect(replayUnavailableReason({ block: "do-not-track" })).toMatch(
		/Do Not Track/,
	);
	expect(replayUnavailableReason({ block: "global-privacy-control" })).toMatch(
		/Global Privacy Control/,
	);
	expect(replayUnavailableReason({ block: null })).toBeNull();
});

it("reads the switch by consent rule", () => {
	// Default-on: on until turned off. Consent first: off until an Accept.
	expect(replaySwitchOn("notice", null)).toBe(true);
	expect(replaySwitchOn("notice", "declined")).toBe(false);
	for (const tier of ["replay", "analytics"] as const) {
		expect(replaySwitchOn(tier, null)).toBe(false);
		expect(replaySwitchOn(tier, "declined")).toBe(false);
		expect(replaySwitchOn(tier, "allowed")).toBe(true);
	}
});

it("shows the banner only before a choice, and not under a privacy signal", () => {
	const base = {
		tier: "replay",
		choice: null,
		block: null,
		signedIn: false,
	} as const;
	expect(consentBannerVisible(base)).toBe(true);
	expect(consentBannerVisible({ ...base, choice: "allowed" })).toBe(false);
	expect(consentBannerVisible({ ...base, choice: "declined" })).toBe(false);
	expect(
		consentBannerVisible({ ...base, block: "global-privacy-control" }),
	).toBe(false);
	// The default-on notice is for visitors; a signed-in user accepted the policy.
	expect(
		consentBannerVisible({ ...base, tier: "notice", signedIn: true }),
	).toBe(false);
	expect(
		consentBannerVisible({ ...base, tier: "analytics", signedIn: true }),
	).toBe(true);
});

it("tells the three rules apart", () => {
	expect(consentTier({ analyticsOptIn: true, replayConsent: true })).toBe(
		"analytics",
	);
	expect(consentTier({ analyticsOptIn: false, replayConsent: true })).toBe(
		"replay",
	);
	expect(consentTier({ analyticsOptIn: false, replayConsent: false })).toBe(
		"notice",
	);
	expect(consentBannerCopy("notice").reject).toBe("Reject all");
});
