import { describe, expect, it, vi } from "vitest";
import {
	isDroppedConnection,
	retryDroppedConnection,
} from "./dropped-connection-retry";

describe("dropped connection retry", () => {
	it("recognizes a connection that dropped, not other failures", () => {
		expect(
			isDroppedConnection(new Error("Connection terminated unexpectedly")),
		).toBe(true);
		expect(isDroppedConnection({ code: "ECONNRESET" })).toBe(true);
		expect(isDroppedConnection(new Error("duplicate key value"))).toBe(false);
		expect(isDroppedConnection("Connection terminated")).toBe(false);
	});

	it("repeats a write once its connection dropped, then succeeds", async () => {
		const run = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
			.mockResolvedValueOnce("saved");
		await expect(retryDroppedConnection(run, { delayMs: 1 })).resolves.toBe(
			"saved",
		);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("gives up after its retries and never repeats other errors", async () => {
		const dropped = vi.fn(async () => {
			throw new Error("Connection terminated unexpectedly");
		});
		await expect(
			retryDroppedConnection(dropped, { delayMs: 1 }),
		).rejects.toThrow("terminated");
		expect(dropped).toHaveBeenCalledTimes(3);
		const other = vi.fn(async () => {
			throw new Error("lease lost");
		});
		await expect(retryDroppedConnection(other, { delayMs: 1 })).rejects.toThrow(
			"lease lost",
		);
		expect(other).toHaveBeenCalledTimes(1);
	});
});
