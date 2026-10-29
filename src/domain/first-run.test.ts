import { expect, it } from "vitest";
import { firstRunStep } from "./first-run";

it("goes GitHub, then repositories, then the model", () => {
	expect(firstRunStep({ githubConnected: false, projectAdded: false })).toBe(
		"github",
	);
	expect(firstRunStep({ githubConnected: true, projectAdded: false })).toBe(
		"repositories",
	);
	expect(firstRunStep({ githubConnected: true, projectAdded: true })).toBe(
		"model",
	);
});
