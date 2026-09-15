import { describe, expect, it } from "vitest";
import { parseOpenCodeAuthStatus } from "./serve-session";

describe("parseOpenCodeAuthStatus", () => {
	it("keeps OpenCode Zen's own sign-in URL", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "awaiting_device_code",
					loginId: "opencode-zen",
					verificationUrl: "https://opencode.ai/auth",
				}),
			),
		).toEqual({
			stage: "awaiting_device_code",
			loginId: "opencode-zen",
			verificationUrl: "https://opencode.ai/auth",
		});
	});

	it("records models only after the server authenticates", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "subscription",
					planType: "OpenCode Zen",
					models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
		});
		expect(parseOpenCodeAuthStatus(null)).toEqual({ stage: "missing" });
	});
});
