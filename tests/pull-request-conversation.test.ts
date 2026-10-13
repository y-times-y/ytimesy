import { expect, it } from "vitest";
import {
	type PullRequestComment,
	pullRequestParticipants,
	pullRequestPerson,
} from "../src/domain/pull-request-review";

it("marks GitHub Apps as bots", () => {
	expect(
		pullRequestPerson({
			login: "greptile-apps[bot]",
			avatar_url: "https://avatars.githubusercontent.com/in/867647?v=4",
			type: "Bot",
		}),
	).toEqual({
		login: "greptile-apps[bot]",
		avatarUrl: "https://avatars.githubusercontent.com/in/867647?v=4",
		bot: true,
	});
	expect(pullRequestPerson({ login: "octocat", type: "User" }).bot).toBe(false);
	expect(pullRequestPerson(null)).toEqual({
		login: "ghost",
		avatarUrl: null,
		bot: false,
	});
});

it("lists the author first and each participant once", () => {
	const author = pullRequestPerson({ login: "growtiv8" });
	const bot = pullRequestPerson({ login: "greptile-apps[bot]", type: "Bot" });
	const entry = (id: string, person = bot): PullRequestComment => ({
		id,
		kind: "comment",
		author: person,
		body: "",
		createdAt: "2026-07-29T00:00:00Z",
		url: null,
	});
	expect(
		pullRequestParticipants(author, [
			entry("1"),
			entry("2", author),
			entry("3"),
		]).map((person) => person.login),
	).toEqual(["growtiv8", "greptile-apps[bot]"]);
});
