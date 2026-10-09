import { expect, it } from "vitest";
import { configuredTurnExecutor } from "../src/domain/turn-executor";

it("keeps the legacy executor unless cutover is explicitly selected", () => {
	expect(configuredTurnExecutor(undefined)).toBe("node");
	expect(configuredTurnExecutor("node")).toBe("node");
	expect(configuredTurnExecutor("durable-object")).toBe("durable-object");
	expect(() => configuredTurnExecutor("typo")).toThrow("Invalid");
});
