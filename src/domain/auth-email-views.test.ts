import { viewPaths } from "@better-auth-ui/core";
import { expect, it } from "vitest";
import { emailViewUnavailableMessage } from "./auth-email-views";

it("says in one line why an email-only view is unavailable", () => {
	expect(viewPaths.auth.signUp).toBe("sign-up");
	expect(emailViewUnavailableMessage(viewPaths.auth.signUp)).toBe(
		"Email sign-up is off here. Use GitHub or Google to sign in.",
	);
	for (const view of [
		viewPaths.auth.forgotPassword,
		viewPaths.auth.resetLinkSent,
	])
		expect(emailViewUnavailableMessage(view)).toBe(
			"Password reset by email is off here.",
		);
});
