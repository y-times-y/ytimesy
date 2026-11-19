import { describe, expect, it } from "vitest";
import {
	authEmailContent,
	authEmailExpired,
	authEmailRetryDelayMs,
	isVerificationCode,
} from "./auth-email";

it("backs off exponentially and caps the delay", () => {
	expect(authEmailRetryDelayMs(1)).toBe(30_000);
	expect(authEmailRetryDelayMs(2)).toBe(60_000);
	expect(authEmailRetryDelayMs(4)).toBe(240_000);
	expect(authEmailRetryDelayMs(20)).toBe(15 * 60_000);
});

it("stops sending links that already expired", () => {
	const created = new Date("2026-10-14T10:00:00Z");
	expect(authEmailExpired(created, new Date("2026-10-14T10:59:00Z"))).toBe(
		false,
	);
	expect(authEmailExpired(created, new Date("2026-10-14T11:01:00Z"))).toBe(
		true,
	);
});

it("includes the action link in both bodies and escapes it in HTML", () => {
	const url = "https://ytimesy.test/api/auth/verify-email?token=a&b=<c>";
	const content = authEmailContent("verify-email", url);
	expect(content.text).toContain(url);
	expect(content.html).toContain("token=a&amp;b=&lt;c&gt;");
	expect(content.html).not.toContain("<c>");
	expect(authEmailContent("reset-password", url).text).toMatch(
		/Reset password/,
	);
});

describe("verification code email", () => {
	it("shows a six-digit code, not a link", () => {
		const { text, html } = authEmailContent("verify-email", "482913");
		expect(text).toContain("482913");
		expect(html).toContain("482913");
		expect(text).not.toContain("http");
		expect(html).not.toContain("href=");
		expect(text).toContain("10 minutes");
	});
	it("still sends a link when the value is a link", () => {
		const { text } = authEmailContent(
			"verify-email",
			"https://app.example.test/api/auth/verify-email?token=abc",
		);
		expect(text).toContain("https://app.example.test/api/auth/verify-email");
	});
	it("tells codes from links", () => {
		expect(isVerificationCode("123456")).toBe(true);
		expect(isVerificationCode("12345")).toBe(false);
		expect(isVerificationCode("1234567")).toBe(false);
		expect(isVerificationCode("https://x.test/1234567")).toBe(false);
	});
});

describe("account-exists email", () => {
	const signIn = "https://app.example.test/auth/sign-in";

	it("tells the owner they already have an account, with sign-in and reset links and no code", () => {
		const { text, html } = authEmailContent("account-exists", signIn);
		expect(text).toContain("already have one");
		expect(text).toContain(`Sign in: ${signIn}`);
		expect(text).toContain("https://app.example.test/auth/forgot-password");
		expect(html).toContain(`href="${signIn}"`);
		expect(html).toContain(
			'href="https://app.example.test/auth/forgot-password"',
		);
		expect(text).not.toMatch(/\b\d{6}\b/);
		expect(text).toContain("If it wasn't you, ignore this email");
	});

	it("escapes the link in HTML", () => {
		const { html } = authEmailContent(
			"account-exists",
			"https://x.test/a?b=<c>&d=1/sign-in",
		);
		expect(html).not.toContain("<c>");
		expect(html).toContain("&lt;c&gt;");
	});
});
