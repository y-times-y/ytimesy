import { describe, expect, it } from "vitest";
import {
	chooseListedModelId,
	isChatgptCliLoginOutput,
	PREFERRED_CODEX_MODEL_ID,
	parseCodexLoginStatus,
} from "./login-status";

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
			messages: [],
			codexVersion: null,
		});
	});
});

describe("chooseListedModelId", () => {
	it("uses gpt-5.3-codex-spark when the connected agent listed it", () => {
		expect(
			chooseListedModelId([
				{ id: "gpt-6-astra", isDefault: true },
				{ id: PREFERRED_CODEX_MODEL_ID },
			]),
		).toBe(PREFERRED_CODEX_MODEL_ID);
	});

	it("never invents a model that was not listed", () => {
		expect(chooseListedModelId([{ id: "gpt-6-astra", isDefault: true }])).toBe(
			"gpt-6-astra",
		);
		expect(chooseListedModelId([])).toBeNull();
	});
});

describe("isChatgptCliLoginOutput", () => {
	it("accepts Codex CLI status on stderr or stdout", () => {
		expect(isChatgptCliLoginOutput("Logged in using ChatGPT")).toBe(true);
		expect(isChatgptCliLoginOutput("not logged in")).toBe(false);
	});
});
