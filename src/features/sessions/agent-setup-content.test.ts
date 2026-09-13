import { describe, expect, it } from "vitest";
import { agentSetupContent } from "./agent-setup-content";

describe("agentSetupContent", () => {
	it("hides setup after Codex is signed in", () => {
		expect(
			agentSetupContent(
				{
					status: "authenticated",
					authMode: "chatgpt",
					planType: "pro",
					email: null,
				},
				true,
			),
		).toBeNull();
	});

	it("names Codex and asks to sign in with ChatGPT", () => {
		expect(agentSetupContent({ status: "disconnected" }, false)).toEqual({
			title: "Codex",
			detail: "Sign in with ChatGPT to use Codex in this workspace.",
			actionLabel: "Sign in",
			userCode: null,
			verificationUrl: null,
		});
	});

	it("does not mention snapshots in the signed-out copy", () => {
		const content = agentSetupContent({ status: "disconnected" }, true);
		expect(content?.detail).toBe("Sign in with ChatGPT to continue.");
		expect(content?.detail.toLowerCase()).not.toContain("snapshot");
		expect(content?.actionLabel).toBe("Sign in");
	});

	it("puts the device code and OpenAI URL in the authorize step", () => {
		expect(
			agentSetupContent(
				{
					status: "awaiting_device_code",
					loginId: "login-1",
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
				},
				false,
			),
		).toEqual({
			title: "Codex",
			detail: "Enter this code on OpenAI to authorize this workspace.",
			actionLabel: "Open OpenAI",
			userCode: "ABCD-1234",
			verificationUrl: "https://auth.openai.com/codex/device",
		});
	});

	it("keeps a failed connection as Codex with a retry action", () => {
		expect(
			agentSetupContent(
				{ status: "failed", message: "The workspace could not start." },
				false,
			),
		).toEqual({
			title: "Codex",
			detail: "The workspace could not start.",
			actionLabel: "Try again",
			userCode: null,
			verificationUrl: null,
		});
	});
});
