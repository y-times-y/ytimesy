import { describe, expect, it } from "vitest";
import { CODEX_PROVIDER } from "#/domain/agent-provider";
import { agentSetupContent } from "./agent-setup-content";

describe("agentSetupContent", () => {
	it("hides setup after an agent is signed in", () => {
		expect(
			agentSetupContent(
				{
					status: "authenticated",
					provider: "codex",
					authMode: "chatgpt",
					planType: "pro",
					email: null,
				},
				true,
			),
		).toBeNull();
	});

	it("lists Codex as an offered agent, not as the product", () => {
		expect(agentSetupContent({ status: "disconnected" }, false)).toEqual({
			heading: "Connect an agent",
			providers: [
				{
					provider: CODEX_PROVIDER,
					detail: "Sign in with ChatGPT.",
					actionLabel: "Sign in",
					userCode: null,
					verificationUrl: null,
				},
			],
		});
	});

	it("does not mention snapshots in the signed-out copy", () => {
		const content = agentSetupContent({ status: "disconnected" }, true);
		expect(content?.providers[0]?.detail).toBe(
			"Sign in with ChatGPT to continue.",
		);
		expect(JSON.stringify(content).toLowerCase()).not.toContain("snapshot");
	});

	it("puts the device code on the Codex row during authorization", () => {
		expect(
			agentSetupContent(
				{
					status: "awaiting_device_code",
					provider: "codex",
					loginId: "login-1",
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
				},
				false,
			),
		).toEqual({
			heading: "Connect an agent",
			providers: [
				{
					provider: CODEX_PROVIDER,
					detail: "Enter this code on OpenAI to authorize this workspace.",
					actionLabel: "Open OpenAI",
					userCode: "ABCD-1234",
					verificationUrl: "https://auth.openai.com/codex/device",
				},
			],
		});
	});

	it("keeps a failed Codex connection on the Codex row", () => {
		expect(
			agentSetupContent(
				{
					status: "failed",
					provider: "codex",
					message: "The workspace could not start.",
				},
				false,
			),
		).toEqual({
			heading: "Connect an agent",
			providers: [
				{
					provider: CODEX_PROVIDER,
					detail: "The workspace could not start.",
					actionLabel: "Try again",
					userCode: null,
					verificationUrl: null,
				},
			],
		});
	});
});
