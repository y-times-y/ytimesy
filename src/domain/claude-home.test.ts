import { describe, expect, it } from "vitest";
import {
	claudeHomeFilesAreUsable,
	claudeSettingsPath,
	claudeSettingsShowingThoughts,
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
		expect(claudeHomeFilesAreUsable({ ".claude.json": "not-json" })).toBe(
			false,
		);
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
		expect(claudeSettingsPath("/home/ubuntu/")).toBe(
			"/home/ubuntu/.claude/settings.json",
		);
	});

	it("keeps existing Claude settings and turns thinking text back on", () => {
		expect(
			JSON.parse(
				claudeSettingsShowingThoughts(
					JSON.stringify({ env: { DISABLE_UPDATES: "1" } }),
				),
			),
		).toEqual({
			env: { DISABLE_UPDATES: "1" },
			showThinkingSummaries: true,
		});
		expect(JSON.parse(claudeSettingsShowingThoughts(null))).toEqual({
			showThinkingSummaries: true,
		});
	});
});
