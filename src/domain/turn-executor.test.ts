import { describe, expect, it } from "vitest";
import { boxTurnUsers, chooseTurnExecutor } from "./turn-executor";

describe("chooseTurnExecutor", () => {
	const base = {
		configured: "durable-object" as const,
		userId: "alice",
		boxUsers: boxTurnUsers("alice, bob"),
		eligible: true,
		boxAlive: true,
	};

	it("sends an enabled user's API turn to a box that was seen lately", () => {
		expect(chooseTurnExecutor(base)).toBe("node");
		expect(chooseTurnExecutor({ ...base, boxUsers: boxTurnUsers("*") })).toBe(
			"node",
		);
	});

	it("keeps the turn in its chat's Durable Object otherwise", () => {
		// No box seen lately: a down fleet never strands a turn.
		expect(chooseTurnExecutor({ ...base, boxAlive: false })).toBe(
			"durable-object",
		);
		// Not enabled, or a subscription or Claude turn.
		expect(chooseTurnExecutor({ ...base, userId: "mallory" })).toBe(
			"durable-object",
		);
		expect(chooseTurnExecutor({ ...base, eligible: false })).toBe(
			"durable-object",
		);
		expect(
			chooseTurnExecutor({ ...base, boxUsers: boxTurnUsers(undefined) }),
		).toBe("durable-object");
	});

	it("never changes a deployment that runs turns on the node executor", () => {
		expect(chooseTurnExecutor({ ...base, configured: "node" })).toBe("node");
	});
});
