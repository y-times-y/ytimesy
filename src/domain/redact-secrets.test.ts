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
	it("removes header and JSON style credentials and AWS key ids", () => {
		const text = redactSecrets(
			'authorization: Basic dXNlcjpwYXNzd29yZA== x-api-key: abcd1234 {"api_key":"short123","token": "tok12345","client_secret":"s3cr"} https://b.s3.amazonaws.com/o?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F2026',
		);
		expect(text).not.toMatch(/dXNlcj|abcd1234|short123|tok12345|s3cr|AKIA/);
		expect(text).toContain("authorization: [redacted]");
		expect(text).toContain("x-api-key: [redacted]");
		expect(text).toContain('"api_key":"[redacted]');
		expect(text).toContain('"token": "[redacted]');
		// Ordinary error text is kept.
		expect(redactSecrets("password authentication failed for user")).toBe(
			"password authentication failed for user",
		);
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
