import { describe, expect, it } from "vitest";
import {
	assistantTextFromOpenCode,
	assistantTextFromOpenCodeMessages,
	errorMessageFromOpenCode,
	OPENCODE_ASSISTANT_GRACE_MS,
	OPENCODE_TURN_MAX_WAIT_MS,
	openCodeSessionIsBusy,
	openCodeTurnFailureMessage,
	openCodeTurnPollDecision,
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

describe("openCodeTurnPollDecision", () => {
	const idle = {
		busy: false,
		seenBusy: false,
		hasAssistantText: false,
		hasError: false,
		elapsedMs: 1_000,
		msSinceLastBusy: null,
	};

	it("keeps polling while OpenCode is busy", () => {
		expect(openCodeTurnPollDecision({ ...idle, busy: true })).toBe("running");
	});

	it("completes when assistant text is present", () => {
		expect(
			openCodeTurnPollDecision({
				...idle,
				seenBusy: true,
				hasAssistantText: true,
				msSinceLastBusy: 20_000,
			}),
		).toBe("completed");
	});

	it("waits after busy clears so /message can catch up", () => {
		expect(
			openCodeTurnPollDecision({
				...idle,
				seenBusy: true,
				msSinceLastBusy: OPENCODE_ASSISTANT_GRACE_MS - 1,
			}),
		).toBe("running");
	});

	it("fails once busy has been gone longer than the grace period", () => {
		expect(
			openCodeTurnPollDecision({
				...idle,
				seenBusy: true,
				msSinceLastBusy: OPENCODE_ASSISTANT_GRACE_MS,
			}),
		).toBe("failed");
	});

	it("fails if OpenCode never becomes busy before the max wait", () => {
		expect(
			openCodeTurnPollDecision({
				...idle,
				elapsedMs: OPENCODE_TURN_MAX_WAIT_MS + 1,
			}),
		).toBe("failed");
	});
});
