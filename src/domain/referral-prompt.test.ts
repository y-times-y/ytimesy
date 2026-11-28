import { describe, expect, it } from "vitest";
import {
	decideReferralPrompt,
	REFERRAL_WARMUP_MIN_TURNS,
	type ReferralPromptFacts,
} from "./referral-prompt";

const now = Date.parse("2026-11-28T12:00:00Z");
const day = 24 * 60 * 60 * 1000;
const base: ReferralPromptFacts = {
	enabled: true,
	capped: false,
	rewardedAsReferred: false,
	completedTurns: REFERRAL_WARMUP_MIN_TURNS,
	warmupShownAt: null,
	lastWindowKey: null,
	dismissedAt: null,
	turnRunning: false,
	notice: null,
	windowKey: null,
	now,
};
const nearLimit = {
	...base,
	notice: "warning" as const,
	windowKey: "five_hour:1",
};
const decide = (changes: Partial<ReferralPromptFacts>) =>
	decideReferralPrompt({ ...base, ...changes });

describe("referral invitation timing", () => {
	it("warms up once, after a few completed turns, not on the first screen", () => {
		expect(decide({ completedTurns: 0 })).toBeNull();
		expect(
			decide({ completedTurns: REFERRAL_WARMUP_MIN_TURNS - 1 }),
		).toBeNull();
		expect(decide({})).toBe("warmup");
		expect(decide({ warmupShownAt: "2026-11-20T00:00:00Z" })).toBeNull();
	});
	it("does not warm up beside a usage notice", () => {
		expect(decide({ notice: "reset", windowKey: "five_hour:1" })).toBeNull();
	});
	it("shows near the limit and at the limit, once per usage window", () => {
		expect(decideReferralPrompt(nearLimit)).toBe("near_limit");
		expect(decideReferralPrompt({ ...nearLimit, notice: "exhausted" })).toBe(
			"near_limit",
		);
		expect(
			decideReferralPrompt({ ...nearLimit, lastWindowKey: "five_hour:1" }),
		).toBeNull();
		expect(
			decideReferralPrompt({ ...nearLimit, lastWindowKey: "five_hour:0" }),
		).toBe("near_limit");
	});
	it("stays quiet for 7 days after a dismissal", () => {
		const dismissed = (days: number) =>
			new Date(now - days * day).toISOString();
		expect(
			decideReferralPrompt({ ...nearLimit, dismissedAt: dismissed(6.9) }),
		).toBeNull();
		expect(decide({ dismissedAt: dismissed(1) })).toBeNull();
		expect(
			decideReferralPrompt({ ...nearLimit, dismissedAt: dismissed(7.1) }),
		).toBe("near_limit");
	});
	it("never while a turn runs, when off, rewarded already, or capped", () => {
		for (const changes of [
			{ turnRunning: true },
			{ enabled: false },
			{ rewardedAsReferred: true },
			{ capped: true },
		]) {
			expect(decide(changes)).toBeNull();
			expect(decideReferralPrompt({ ...nearLimit, ...changes })).toBeNull();
		}
	});
});
