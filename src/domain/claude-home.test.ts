import { describe, expect, it } from "vitest";
import {
	claudeHomeFilesAreUsable,
	parseClaudeHomeDump,
	siblingClaudeHomePaths,
} from "./claude-home";

describe("Claude home reuse", () => {
	it("accepts a guest .claude.json that already holds Anthropic OAuth", () => {
		const files = {
			".claude.json": JSON.stringify({
				oauthAccount: { emailAddress: "het@example.com" },
				hasCompletedOnboarding: true,
			}),
		};
		expect(claudeHomeFilesAreUsable(files)).toBe(true);
		expect(
			parseClaudeHomeDump(JSON.stringify({ home: "/home/ubuntu", files })),
		).toEqual({ files });
	});

	it("rejects empty, junk, or key-only dumps so a new chat still signs in", () => {
		expect(claudeHomeFilesAreUsable({})).toBe(false);
		expect(
			claudeHomeFilesAreUsable({ ".claude.json": "not-json" }),
		).toBe(false);
		expect(
			claudeHomeFilesAreUsable({
				".claude.json": JSON.stringify({ theme: "dark" }),
			}),
		).toBe(false);
		expect(parseClaudeHomeDump("not-json")).toBeNull();
	});

	it("builds sibling home paths without a trailing slash", () => {
		expect(siblingClaudeHomePaths("/home/ubuntu/")).toEqual([
			"/home/ubuntu/.claude.json",
			"/home/ubuntu/.claude/.credentials.json",
		]);
	});
});
