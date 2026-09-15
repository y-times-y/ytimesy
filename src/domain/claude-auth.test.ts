import { describe, expect, it } from "vitest";
import {
	claudeCliIsSignedIn,
	isAnthropicAuthorizeUrl,
	parseAnthropicLoginUrl,
	parseClaudeListedModels,
} from "./claude-auth";

describe("Claude Code login parsing", () => {
	it("keeps Anthropic's authorize URL and rejects wrapped or localhost callbacks", () => {
		const output = [
			"Browser didn't open. Use this URL:",
			"https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
			"Local callback http://localhost:54134/callback",
			"Do not use https://ytimesy.com/login",
		].join("\n");
		expect(parseAnthropicLoginUrl(output)).toMatch(
			/^https:\/\/claude\.ai\/oauth\/authorize\?/,
		);
		expect(
			isAnthropicAuthorizeUrl("https://ytimesy.com/login?next=claude"),
		).toBe(false);
		expect(isAnthropicAuthorizeUrl("http://localhost:54134/callback")).toBe(
			false,
		);
	});

	it("does not treat a stored key or empty status as signed in", () => {
		expect(claudeCliIsSignedIn("")).toBe(false);
		expect(claudeCliIsSignedIn("Not logged in")).toBe(false);
		expect(claudeCliIsSignedIn("API key saved")).toBe(false);
		expect(claudeCliIsSignedIn("Logged in as het@example.com")).toBe(true);
		expect(claudeCliIsSignedIn("Login successful")).toBe(true);
	});

	it("loads model names only from Claude Code output", () => {
		expect(
			parseClaudeListedModels(
				JSON.stringify({
					models: [
						{ id: "claude-sonnet-4-5", label: "Sonnet" },
						{ id: "claude-opus-4-6", name: "Opus" },
					],
				}),
			),
		).toEqual([
			{ id: "claude-sonnet-4-5", label: "Sonnet" },
			{ id: "claude-opus-4-6", label: "Opus" },
		]);
		expect(
			parseClaudeListedModels(
				["* sonnet (claude-sonnet-4-5)", "  opus (claude-opus-4-6)"].join("\n"),
			),
		).toEqual([
			{ id: "claude-sonnet-4-5", label: "sonnet" },
			{ id: "claude-opus-4-6", label: "opus" },
		]);
		expect(parseClaudeListedModels("not a model list")).toEqual([]);
	});
});
