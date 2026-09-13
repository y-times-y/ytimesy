import { describe, expect, it } from "vitest";
import { parseCodexLoginStatus } from "./login-status";

describe("parseCodexLoginStatus", () => {
	it("keeps a pending device code out of authenticated state", () => {
		expect(
			parseCodexLoginStatus(
				JSON.stringify({
					stage: "awaiting_device_code",
					loginId: "login-1",
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
					codexVersion: "0.154.0",
				}),
			),
		).toEqual({
			stage: "awaiting_device_code",
			loginId: "login-1",
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "ABCD-1234",
			codexVersion: "0.154.0",
		});
	});

	it("records ChatGPT authentication and listed models only", () => {
		expect(
			parseCodexLoginStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "chatgpt",
					planType: "plus",
					models: [{ id: "gpt-test", label: "GPT Test" }],
					turn: {
						threadId: "thr_1",
						modelId: "gpt-test",
						status: "completed",
						text: "pong",
						error: null,
					},
				}),
			),
		).toEqual({
			stage: "authenticated",
			authMode: "chatgpt",
			planType: "plus",
			models: [{ id: "gpt-test", label: "GPT Test" }],
			turn: {
				threadId: "thr_1",
				modelId: "gpt-test",
				status: "completed",
				text: "pong",
				error: null,
			},
			codexVersion: null,
		});
	});
});
