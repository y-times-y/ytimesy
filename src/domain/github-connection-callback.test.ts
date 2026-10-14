import { expect, it } from "vitest";
import {
	githubConnectionFailureMessage,
	githubConnectionFailureReason,
} from "./github-connection-callback";

it("reads known reasons and treats unknown ones as a generic failure", () => {
	expect(githubConnectionFailureReason(null)).toBeNull();
	expect(githubConnectionFailureReason("wrong-account")).toBe("wrong-account");
	expect(githubConnectionFailureReason("something")).toBe("failed");
});

it("explains the wrong-account case instead of calling it canceled", () => {
	expect(githubConnectionFailureMessage("wrong-account")).toMatch(
		/signed in with/,
	);
	expect(githubConnectionFailureMessage("denied")).toMatch(/canceled/);
	expect(githubConnectionFailureMessage("expired")).toMatch(/expired/);
});
