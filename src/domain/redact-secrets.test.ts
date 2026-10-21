import { describe, expect, it } from "vitest";
import { replaySnapshotData } from "#/features/analytics/replay-privacy";
import { redactDeep, redactSecrets, replaySafeUrl } from "./redact-secrets";

describe("secret redaction", () => {
	it("removes Google keys, JWTs and short token/code values", () => {
		const text = redactSecrets(
			"key AIzaSyA1234567890abcdefghijklmnop jwt eyJhbGciOi.eyJzdWIiOjF9.sig /cb?code=abc12&token=xyz",
		);
		expect(text).not.toMatch(/AIza|eyJ|abc12|xyz/);
		expect(text).toContain("code=[redacted]");
		expect(text).toContain("token=[redacted]");
	});
	it("redacts nested exception values", () => {
		expect(
			redactDeep([{ value: "failed ghp_abcdefghijklmnop", n: 1 }]),
		).toEqual([{ value: "failed [redacted]", n: 1 }]);
	});
	it("strips query strings and drops /auth pages from replay", () => {
		expect(replaySafeUrl("https://a.dev/chat/1?x=1#y")).toBe(
			"https://a.dev/chat/1",
		);
		expect(
			replaySafeUrl("https://a.dev/auth/reset-password?token=t"),
		).toBeNull();
		expect(
			replaySnapshotData([
				{ type: 4, data: { href: "https://a.dev/p?token=t" } },
				{
					type: 4,
					data: { href: "https://a.dev/auth/reset-password?token=t" },
				},
				{ type: 2, data: {} },
			]),
		).toEqual([
			{ type: 4, data: { href: "https://a.dev/p" } },
			{ type: 2, data: {} },
		]);
	});
});
