import { describe, expect, it } from "vitest";
import { filteredAnalyticsProperties } from "./analytics";
import { authErrorKind, authViewFromPath } from "./auth-funnel";

describe("authErrorKind", () => {
	it("names the failure without carrying any text from it", () => {
		expect(authErrorKind({ code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(
			"wrong_password",
		);
		expect(authErrorKind({ code: "EMAIL_NOT_VERIFIED" })).toBe(
			"email_not_verified",
		);
		expect(authErrorKind({ code: "USER_ALREADY_EXISTS" })).toBe(
			"already_registered",
		);
		expect(authErrorKind({ code: "PASSWORD_TOO_SHORT" })).toBe("weak_password");
		expect(authErrorKind({ code: "INVALID_OTP" })).toBe("invalid_code");
		expect(authErrorKind({ status: 429 })).toBe("rate_limited");
	});

	it("tells a missing or rejected Turnstile token apart", () => {
		expect(authErrorKind({ code: "MISSING_RESPONSE" })).toBe("captcha_missing");
		expect(authErrorKind({ message: "Missing CAPTCHA response" })).toBe(
			"captcha_missing",
		);
		expect(authErrorKind({ message: "Captcha verification failed" })).toBe(
			"captcha_failed",
		);
	});

	it("falls back to other", () => {
		expect(authErrorKind({ code: "SOMETHING_NEW" })).toBe("other");
		expect(authErrorKind(null)).toBe("other");
	});
});

describe("auth_funnel event", () => {
	it("keeps the step, view and kind", () => {
		expect(
			filteredAnalyticsProperties("auth_funnel", {
				view: "sign_in",
				step: "error",
				kind: "wrong_password",
			}),
		).toEqual({ view: "sign_in", step: "error", kind: "wrong_password" });
	});

	it("drops events carrying free text such as an email address", () => {
		expect(
			filteredAnalyticsProperties("auth_funnel", {
				view: "sign_in",
				step: "error",
				kind: "a@b.co",
			}),
		).toBeNull();
	});
});

describe("authViewFromPath", () => {
	it("maps auth pages and defaults to sign in", () => {
		expect(authViewFromPath("/auth/sign-up")).toBe("sign_up");
		expect(authViewFromPath("/auth/verify-email")).toBe("verify_email");
		expect(authViewFromPath("/auth/forgot-password")).toBe("forgot_password");
		expect(authViewFromPath("/auth/reset-password")).toBe("reset_password");
		expect(authViewFromPath("/auth/sign-in")).toBe("sign_in");
	});
});
