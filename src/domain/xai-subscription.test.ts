import { describe, expect, it } from "vitest";
import {
	XAI_REFUSAL_COOLDOWN_MS,
	xaiConnectionMayServe,
	xaiForbiddenVerdict,
} from "./xai-subscription";

describe("xaiConnectionMayServe", () => {
	it("serves a ready connection", () => {
		expect(xaiConnectionMayServe("ready", 0)).toBe(true);
	});
	it("tries a refused connection again once the cooldown has passed", () => {
		expect(xaiConnectionMayServe("not-eligible", 1_000)).toBe(false);
		expect(xaiConnectionMayServe("not-eligible", XAI_REFUSAL_COOLDOWN_MS)).toBe(
			true,
		);
	});
	it("keeps a rejected sign-in waiting for the user", () => {
		expect(
			xaiConnectionMayServe("reconnect", 10 * XAI_REFUSAL_COOLDOWN_MS),
		).toBe(false);
	});
});

describe("xaiForbiddenVerdict", () => {
	it("records a refusal that names the plan", () => {
		expect(
			xaiForbiddenVerdict(
				'{"error":"Your subscription does not include Grok"}',
			),
		).toBe("not-eligible");
	});
	it("does not record an empty or unrelated 403", () => {
		expect(xaiForbiddenVerdict("")).toBe("unavailable");
		expect(xaiForbiddenVerdict("Forbidden")).toBe("unavailable");
		expect(xaiForbiddenVerdict("request blocked by rate limit")).toBe(
			"unavailable",
		);
	});
});
