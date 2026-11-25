import { describe, expect, it } from "vitest";
import { GITHUB_SETUP_MESSAGE, needsGithubSetup } from "./github-sign-in";

describe("environment setup without a GitHub link", () => {
	it("has a message the UI recognises as needing GitHub", () => {
		expect(needsGithubSetup(GITHUB_SETUP_MESSAGE)).toBe(true);
	});
	it("does not treat the generic failure as a GitHub problem", () => {
		expect(
			needsGithubSetup(
				"Could not start environment setup. Check repository access and the selected branches, then retry.",
			),
		).toBe(false);
	});
});
