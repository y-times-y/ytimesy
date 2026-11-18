import { expect, it } from "vitest";
import { isAuthEntryView } from "./auth-entry-views";

it("sends signed-in people away from entry views only", () => {
	for (const path of ["sign-in", "sign-up", "verify-email", "forgot-password"])
		expect(isAuthEntryView(path), path).toBe(true);
	for (const path of ["sign-out", "callback", "error", "reset-password"])
		expect(isAuthEntryView(path), path).toBe(false);
});
