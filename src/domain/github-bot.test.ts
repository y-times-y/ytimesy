import { describe, expect, it } from "vitest";
import {
	githubAppBotFromEnv,
	githubAppBotIdentity,
	githubAppMention,
	githubAppMentionPattern,
} from "./github-bot";

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

describe("githubAppMention", () => {
	it("is the App's own handle, never the unrelated @ytimesy user", () => {
		expect(githubAppMention("ytimesy-agent")).toBe("@ytimesy-agent");
		expect(githubAppMention(" ")).toBeNull();
	});

	it("recognises @<slug> (and legacy @ytimesy) only as a whole mention", () => {
		const pattern = githubAppMentionPattern("ytimesy-agent");
		for (const body of [
			"@ytimesy-agent fix it",
			"please @ytimesy-agent",
			"(@YTIMESY-AGENT) fix",
			"@ytimesy-agent[bot] fix",
			"@ytimesy fix it",
		])
			expect(pattern.test(body), body).toBe(true);
		for (const body of [
			"@ytimesy-agents hi",
			"@ytimesy-agent-x hi",
			"me@ytimesy-agent.dev",
			"see org/@ytimesy-agent",
			"@ytimesy-bot hi",
			"no mention",
		])
			expect(pattern.test(body), body).toBe(false);
		expect(githubAppMentionPattern(null).test("@ytimesy go")).toBe(true);
	});
});
