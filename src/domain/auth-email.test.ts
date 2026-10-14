import { expect, it } from "vitest";
import {
	authEmailContent,
	authEmailExpired,
	authEmailRetryDelayMs,
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
