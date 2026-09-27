import { describe, expect, it } from "vitest";
import {
	claudeBackgroundTurnResult,
	claudeCliIsSignedIn,
	claudeListedModelsAreUsable,
	claudeSessionRemembersSignIn,
	isAnthropicAuthorizeUrl,
	parseAnthropicLoginUrl,
	parseClaudeAuthPasteCode,
	parseClaudeBinaryPath,
	parseClaudeCapabilitiesFromHelp,
	parseClaudeHomePath,
	parseClaudeListedModels,
	parseClaudeModelFlagsFromHelp,
	rememberedClaudeModels,
} from "./claude-auth";

describe("Claude Code login parsing", () => {
	it("reads the guest binary from locate output and ignores a missing install", () => {
		expect(
			parseClaudeBinaryPath(
				["CLAUDE_HOME=/home/ubuntu", "CLAUDE_BIN=/usr/local/bin/claude"].join(
					"\n",
				),
			),
		).toBe("/usr/local/bin/claude");
		expect(parseClaudeBinaryPath("claude binary not found")).toBeNull();
		expect(
			parseClaudeHomePath(
				["CLAUDE_HOME=/home/ubuntu", "CLAUDE_BIN=/usr/local/bin/claude"].join(
					"\n",
				),
			),
		).toBe("/home/ubuntu");
	});

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
			parseAnthropicLoginUrl(
				"https://claude.com/cai/oauth/authorize?code=true&client_id=abc",
			),
		).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
		expect(
			isAnthropicAuthorizeUrl("https://ytimesy.com/login?next=claude"),
		).toBe(false);
		expect(isAnthropicAuthorizeUrl("http://localhost:54134/callback")).toBe(
			false,
		);
	});

	it("accepts Anthropic's paste-back code and rejects keys or device codes", () => {
		expect(parseClaudeAuthPasteCode("ABC123#XYZ789")).toBe("ABC123#XYZ789");
		expect(parseClaudeAuthPasteCode("  ABC123#XYZ789  ")).toBe("ABC123#XYZ789");
		expect(
			parseClaudeAuthPasteCode(
				"https://platform.claude.com/oauth/code/callback?code=ABC123&state=XYZ789",
			),
		).toBe("ABC123#XYZ789");
		expect(parseClaudeAuthPasteCode("")).toBeNull();
		expect(parseClaudeAuthPasteCode("ABCD-1234")).toBeNull();
		expect(parseClaudeAuthPasteCode("sk-ant-api03-secret")).toBeNull();
		expect(parseClaudeAuthPasteCode("sk-ant-oat01-secret")).toBeNull();
		expect(parseClaudeAuthPasteCode("not a code")).toBeNull();
	});

	it("remembers a prior Claude sign-in from the stored model id", () => {
		expect(claudeSessionRemembersSignIn("fable")).toBe(true);
		expect(claudeSessionRemembersSignIn("opus")).toBe(true);
		expect(claudeSessionRemembersSignIn("")).toBe(false);
		expect(rememberedClaudeModels("fable")).toEqual([
			{ id: "fable", label: "fable" },
			{ id: "opus", label: "opus" },
			{ id: "sonnet", label: "sonnet" },
		]);
	});

	it("does not treat a stored key or empty status as signed in", () => {
		expect(claudeCliIsSignedIn("")).toBe(false);
		expect(claudeCliIsSignedIn("Not logged in")).toBe(false);
		expect(claudeCliIsSignedIn("API key saved")).toBe(false);
		expect(claudeCliIsSignedIn("Logged in as het@example.com")).toBe(true);
		expect(claudeCliIsSignedIn("Login successful")).toBe(true);
		expect(claudeCliIsSignedIn('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(
			true,
		);
		expect(claudeCliIsSignedIn('{"loggedIn":false}')).toBe(false);
	});

	it("collects a background Claude turn without inventing a reply", () => {
		expect(
			claudeBackgroundTurnResult({
				exitText: null,
				output: "",
				pidAlive: true,
			}),
		).toEqual({ kind: "running" });
		expect(
			claudeBackgroundTurnResult({
				exitText: "0\n",
				output: "pong",
				pidAlive: false,
			}),
		).toEqual({ kind: "completed", text: "pong" });
		expect(
			claudeBackgroundTurnResult({
				exitText: "1\n",
				output: "",
				pidAlive: false,
			}),
		).toEqual({
			kind: "failed",
			message: "Claude Code did not return a response.",
		});
		expect(
			claudeBackgroundTurnResult({
				exitText: null,
				output: null,
				pidAlive: false,
				pidFilePresent: false,
			}),
		).toEqual({ kind: "running" });
		expect(
			claudeBackgroundTurnResult({
				exitText: null,
				output: "pong",
				pidAlive: false,
				pidFilePresent: true,
			}),
		).toEqual({ kind: "completed", text: "pong" });
		expect(
			claudeBackgroundTurnResult({
				exitText: null,
				output: `{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}\n{"type":"result","result":"pong"}\n`,
				pidAlive: true,
				pidFilePresent: true,
			}),
		).toMatchObject({ kind: "completed" });
	});

	it("loads --model aliases from Claude Code help and ignores a chat reply", () => {
		expect(
			parseClaudeModelFlagsFromHelp(
				"Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').",
			),
		).toEqual([
			{ id: "fable", label: "claude-fable-5" },
			{ id: "opus", label: "opus" },
			{ id: "sonnet", label: "sonnet" },
		]);
		expect(
			parseClaudeModelFlagsFromHelp(
				[
					"--model <model>                       Model for the current session. Provide",
					"                                        an alias for the latest model (e.g.",
					"                                        'fable', 'opus', or 'sonnet') or a",
					"                                        model's full name (e.g.",
					"                                        'claude-fable-5').",
					"      Comma or space-separated list of tool names to allow (e.g. \"Bash(git *)",
				].join("\n"),
			),
		).toEqual([
			{ id: "fable", label: "claude-fable-5" },
			{ id: "opus", label: "opus" },
			{ id: "sonnet", label: "sonnet" },
		]);
		expect(
			parseClaudeListedModels(
				"Could you clarify what you'd like to know about models?",
			),
		).toEqual([]);
	});

	it("loads reasoning and Fast only when Claude Code advertises them", () => {
		expect(
			parseClaudeCapabilitiesFromHelp(
				"--effort <level> Effort level (low, medium, high, xhigh, max)\n--fast Use fast mode",
			),
		).toEqual({
			reasoning: {
				levels: [
					{ id: "low", label: "low" },
					{ id: "medium", label: "medium" },
					{ id: "high", label: "high" },
					{ id: "xhigh", label: "xhigh" },
					{ id: "max", label: "max" },
				],
				defaultLevelId: "medium",
			},
			supportsFastMode: true,
		});
		expect(parseClaudeCapabilitiesFromHelp("--model <model>")).toEqual({
			supportsFastMode: false,
		});
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
		expect(
			claudeListedModelsAreUsable([
				{ id: "fable" },
				{ id: "opus" },
				{ id: "sonnet" },
			]),
		).toBe(true);
		expect(
			claudeListedModelsAreUsable([
				{ id: 'e.g. "Bash(git *' },
			]),
		).toBe(false);
	});
});
