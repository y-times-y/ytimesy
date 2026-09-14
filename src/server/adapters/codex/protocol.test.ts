import { describe, expect, it } from "vitest";
import { agentConnectionFromProbe, parseCodexProbeReport } from "./protocol";

describe("Codex probe protocol", () => {
	it("does not treat a pending device code as ChatGPT authentication", () => {
		const report = parseCodexProbeReport(
			`noise\nYTIMESY_PROOF=${JSON.stringify({
				ok: true,
				stage: "loginStart",
				codexVersion: "0.1.0",
				account: { account: null, requiresOpenaiAuth: true },
				login: {
					type: "chatgptDeviceCode",
					loginId: "login-1",
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
				},
			})}\n`,
		);

		expect(agentConnectionFromProbe(report)).toEqual({
			status: "awaiting_device_code",
			provider: "codex",
			loginId: "login-1",
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "ABCD-1234",
		});
	});

	it("treats API-key login without an account as a missing key, not a silent fallback", () => {
		const report = parseCodexProbeReport(
			`YTIMESY_PROOF=${JSON.stringify({
				ok: true,
				stage: "loginStart",
				login: { type: "apiKey" },
			})}\n`,
		);

		expect(agentConnectionFromProbe(report)).toEqual({
			status: "failed",
			provider: "codex",
			message:
				"Codex is waiting for an API key. Paste one in the harness picker, or sign in with ChatGPT.",
		});
	});

	it("maps ChatGPT account/read into authenticated state", () => {
		const report = parseCodexProbeReport(
			`YTIMESY_PROOF=${JSON.stringify({
				ok: true,
				stage: "accountRead",
				account: {
					account: { type: "chatgpt", email: null, planType: "plus" },
					requiresOpenaiAuth: true,
				},
			})}\n`,
		);

		expect(agentConnectionFromProbe(report)).toEqual({
			status: "authenticated",
			provider: "codex",
			authMode: "chatgpt",
			planType: "plus",
			email: null,
		});
	});
});
