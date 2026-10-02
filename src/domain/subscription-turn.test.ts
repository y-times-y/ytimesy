import { expect, it } from "vitest";
import {
	subscriptionTurnRevision,
	subscriptionTurnSettings,
} from "./subscription-turn";

it("requires explicit subscription identity, not a missing API connection", () => {
	expect(subscriptionTurnSettings("api-revision")).toBeNull();
	expect(subscriptionTurnSettings("")).toBeNull();
	expect(
		subscriptionTurnSettings(subscriptionTurnRevision("high", false)),
	).toEqual({ reasoning: "high", fast: false });
});

it("rejects corrupt durable transport settings", () => {
	expect(() =>
		subscriptionTurnSettings('codex-subscription:v1:{"fast":"yes"}'),
	).toThrow();
	expect(() =>
		subscriptionTurnSettings("codex-subscription:v1:not-json"),
	).toThrow();
});
