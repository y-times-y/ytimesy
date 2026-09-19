import { describe, expect, it } from "vitest";
import { githubAppBotFromEnv, githubAppBotIdentity } from "./github-bot";

describe("githubAppBotIdentity", () => {
	it("builds the GitHub App noreply identity GitHub links to the bot", () => {
		expect(
			githubAppBotIdentity({ id: "4932652", slug: "ytimesy-cloud" }),
		).toEqual({
			name: "ytimesy-cloud[bot]",
			email: "4932652+ytimesy-cloud[bot]@users.noreply.github.com",
		});
	});

	it("rejects an incomplete App id or slug", () => {
		expect(githubAppBotIdentity({ id: "", slug: "ytimesy-cloud" })).toBeNull();
		expect(githubAppBotIdentity({ id: "4932652", slug: "" })).toBeNull();
		expect(githubAppBotFromEnv({})).toBeNull();
	});
});
