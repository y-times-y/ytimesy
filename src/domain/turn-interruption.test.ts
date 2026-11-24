import { describe, expect, it } from "vitest";
import { TURN_NOT_STARTED } from "./api-turn-failure";
import { CoordinationFailure } from "./conversation-turn-control";
import {
	GENUINE_STEP_RETRIES,
	isEdgeOutage,
	isTransientInfrastructureFailure,
	MAX_TRANSIENT_ATTEMPTS,
	shouldRetryStep,
	stepRetryDelayMs,
	TRANSIENT_RETRY_WINDOW_MS,
} from "./turn-interruption";

describe("turn interruption rules", () => {
	it("treats coordinator, lease and start-wait trouble as transient", () => {
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure(
					"renew",
					{ kind: "transport", category: "timeout" },
					1,
				),
			),
		).toBe(true);
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure("renew", { kind: "http", status: 503 }, 3),
			),
		).toBe(true);
		for (const message of [
			TURN_NOT_STARTED,
			"Conversation coordination lease was lost.",
			"Turn heartbeat or coordination service became unavailable.",
		])
			expect(isTransientInfrastructureFailure(new Error(message))).toBe(true);
	});
	it("never retries a refusal, a Stop or an ordinary bug as infrastructure", () => {
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure("acquire", { kind: "http", status: 409 }, 1),
			),
		).toBe(false);
		expect(
			isTransientInfrastructureFailure(
				new Error("Turn ownership or cancellation state changed."),
			),
		).toBe(false);
		expect(isTransientInfrastructureFailure(new Error("boom"))).toBe(false);
		expect(isTransientInfrastructureFailure(undefined)).toBe(false);
	});
	it("recognises an edge outage by status", () => {
		const refused = Object.assign(new Error("x"), {
			name: "TurnBoxVmRefused",
			status: 503,
		});
		expect(isEdgeOutage(refused)).toBe(true);
		expect(isEdgeOutage(Object.assign(refused, { status: 403 }))).toBe(false);
	});
	it("backs off 5, 10, 20, 40, then 60 s", () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(stepRetryDelayMs)).toEqual([
			5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
	});
	it("waits out infrastructure trouble for the whole window, not 3 tries", () => {
		const start = 1_000_000;
		const at = (failures: number, elapsed: number) =>
			shouldRetryStep({
				transient: true,
				failures,
				firstFailureAt: start,
				now: start + elapsed,
			});
		expect(at(4, 60_000)).toBe(true);
		expect(at(MAX_TRANSIENT_ATTEMPTS - 1, TRANSIENT_RETRY_WINDOW_MS - 1)).toBe(
			true,
		);
		expect(at(5, TRANSIENT_RETRY_WINDOW_MS)).toBe(false);
		expect(at(MAX_TRANSIENT_ATTEMPTS, 1)).toBe(false);
	});
	it("keeps the old bound for a step failing for another reason", () => {
		const base = { transient: false, firstFailureAt: 0, now: 0 };
		expect(shouldRetryStep({ ...base, failures: GENUINE_STEP_RETRIES })).toBe(
			true,
		);
		expect(
			shouldRetryStep({ ...base, failures: GENUINE_STEP_RETRIES + 1 }),
		).toBe(false);
	});
});
