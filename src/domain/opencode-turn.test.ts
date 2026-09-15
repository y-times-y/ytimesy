import { describe, expect, it } from "vitest";
import {
	assistantTextFromOpenCode,
	assistantTextFromOpenCodeMessages,
	errorMessageFromOpenCode,
	openCodeSessionIsBusy,
	openCodeTurnFailureMessage,
} from "./opencode-turn";

describe("assistantTextFromOpenCode", () => {
	it("reads the documented { info, parts } reply", () => {
		expect(
			assistantTextFromOpenCode({
				info: { role: "assistant", id: "msg-1" },
				parts: [{ type: "text", text: "Wrote SESSION_ISOLATION.md" }],
			}),
		).toBe("Wrote SESSION_ISOLATION.md");
	});

	it("ignores tool parts that have no assistant text", () => {
		expect(
			assistantTextFromOpenCode({
				parts: [{ type: "tool", name: "bash" }],
			}),
		).toBeNull();
	});
});

describe("assistantTextFromOpenCodeMessages", () => {
	it("uses the latest assistant message in a session list", () => {
		expect(
			assistantTextFromOpenCodeMessages([
				{
					info: { role: "user" },
					parts: [{ type: "text", text: "ping" }],
				},
				{
					info: { role: "assistant" },
					parts: [{ type: "text", text: "pong" }],
				},
			]),
		).toBe("pong");
	});
});

describe("errorMessageFromOpenCode", () => {
	it("surfaces provider errors instead of a blank reply", () => {
		expect(
			errorMessageFromOpenCode({
				error: { message: "Zen quota exceeded" },
			}),
		).toBe("Zen quota exceeded");
	});
});

describe("openCodeSessionIsBusy", () => {
	it("treats retry as still running", () => {
		expect(
			openCodeSessionIsBusy(
				{ "ses-1": { type: "retry", attempt: 1, message: "rate limit" } },
				"ses-1",
			),
		).toBe(true);
		expect(openCodeSessionIsBusy({ "ses-1": { type: "idle" } }, "ses-1")).toBe(
			false,
		);
	});
});

describe("openCodeTurnFailureMessage", () => {
	it("does not invent a fallback provider", () => {
		expect(openCodeTurnFailureMessage({ payload: null, httpStatus: 429 })).toBe(
			"OpenCode HTTP 429. ytimesy did not fall back to another provider.",
		);
	});
});
