import { describe, expect, it } from "vitest";
import { parseOpenCodeAuthStatus } from "./serve-session";

describe("parseOpenCodeAuthStatus", () => {
	it("treats a healthy server as connected without a login", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "local",
					models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			authMode: "local",
			models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
		});
		expect(parseOpenCodeAuthStatus(null)).toEqual({ stage: "missing" });
	});

	it("does not keep a Zen login wait state", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "awaiting_device_code",
					loginId: "opencode-zen",
					verificationUrl: "https://opencode.ai/auth",
				}),
			),
		).toEqual({ stage: "missing" });
	});
});
