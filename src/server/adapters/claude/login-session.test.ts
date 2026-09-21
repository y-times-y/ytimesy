import { describe, expect, it } from "vitest";
import { parseClaudeAuthStatus } from "./login-session";

describe("parseClaudeAuthStatus", () => {
	it("keeps Anthropic's URL in authorizing state", () => {
		expect(
			parseClaudeAuthStatus(
				JSON.stringify({
					stage: "awaiting_device_code",
					loginId: "claude-auth",
					verificationUrl:
						"https://claude.ai/oauth/authorize?code=true&client_id=abc",
				}),
			),
		).toEqual({
			stage: "awaiting_device_code",
			loginId: "claude-auth",
			verificationUrl:
				"https://claude.ai/oauth/authorize?code=true&client_id=abc",
		});
	});

	it("does not treat missing models as a fabricated catalog", () => {
		expect(
			parseClaudeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "subscription",
					models: [{ id: "claude-sonnet-4-5", label: "Sonnet" }],
				}),
			),
		).toEqual({
			stage: "authenticated",
			authMode: "subscription",
			planType: null,
			models: [{ id: "claude-sonnet-4-5", label: "Sonnet" }],
			turnStatus: "idle",
			items: [],
		});
		expect(parseClaudeAuthStatus(null)).toEqual({ stage: "missing" });
	});

	it("keeps thinking text when rereading the guest status file", () => {
		expect(
			parseClaudeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "subscription",
					models: [],
					turnStatus: "running",
					items: [
						{
							kind: "userMessage",
							id: "u1",
							text: "look around",
						},
						{
							kind: "reasoning",
							id: "r1",
							summaries: ["I should list the workspace first."],
						},
					],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			items: [
				{ kind: "userMessage", text: "look around" },
				{
					kind: "reasoning",
					summaries: ["I should list the workspace first."],
				},
			],
		});
	});
});
