import { describe, expect, it } from "vitest";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import {
	OPENCODE_START_SERVE_SCRIPT,
	parseCurlHttp,
	parseOpenCodeAuthStatus,
} from "./serve-session";

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

describe("OPENCODE_START_SERVE_SCRIPT", () => {
	it("starts serve from the project checkout", () => {
		expect(OPENCODE_START_SERVE_SCRIPT).toContain(PROJECT_CWD_PATH);
		expect(OPENCODE_START_SERVE_SCRIPT).toContain('cd "$SERVE_CWD"');
	});
});

describe("parseCurlHttp", () => {
	it("keeps JSON bodies when the status is not 2xx", () => {
		expect(
			parseCurlHttp('{"error":{"message":"Zen quota exceeded"}}\n429'),
		).toEqual({
			status: 429,
			body: { error: { message: "Zen quota exceeded" } },
			raw: '{"error":{"message":"Zen quota exceeded"}}',
		});
	});
});
