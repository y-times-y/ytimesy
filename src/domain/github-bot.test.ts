import { describe, expect, it } from "vitest";
import { githubAppBotFromEnv, githubAppBotIdentity } from "./github-bot";

describe("githubAppBotIdentity", () => {
	it("uses the bot user id so GitHub attaches the App logo", () => {
		expect(
			githubAppBotIdentity({ userId: "328807657", slug: "ytimesy-cloud" }),
		).toEqual({
			name: "ytimesy-cloud[bot]",
			email: "328807657+ytimesy-cloud[bot]@users.noreply.github.com",
		});
	});

	it("rejects an incomplete bot user id or slug", () => {
		expect(
			githubAppBotIdentity({ userId: "", slug: "ytimesy-cloud" }),
		).toBeNull();
		expect(githubAppBotIdentity({ userId: "328807657", slug: "" })).toBeNull();
		expect(githubAppBotFromEnv({})).toBeNull();
		expect(
			githubAppBotFromEnv({
				GITHUB_APP_BOT_USER_ID: "328807657",
				GITHUB_APP_SLUG: "ytimesy-cloud",
			}),
		).toEqual({
			name: "ytimesy-cloud[bot]",
			email: "328807657+ytimesy-cloud[bot]@users.noreply.github.com",
		});
	});
});
