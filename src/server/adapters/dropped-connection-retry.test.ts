import { describe, expect, it, vi } from "vitest";
import {
	isConnectFailure,
	isDroppedConnection,
	retryConnectFailure,
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

describe("connect failure retry", () => {
	it("classifies pool connect timeouts and refusals, not mid-statement failures", () => {
		for (const error of [
			new Error("timeout exceeded when trying to connect"),
			new Error("Connection terminated due to connection timeout"),
			Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:5432"), {
				code: "ETIMEDOUT",
				syscall: "connect",
			}),
			Object.assign(new Error("cannot connect now"), { code: "57P03" }),
			Object.assign(new Error("sorry, too many clients already"), {
				code: "53300",
			}),
		])
			expect(isConnectFailure(error)).toBe(true);
		expect(
			isConnectFailure(
				Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }),
			),
		).toBe(false);
		expect(isConnectFailure(new Error("duplicate key value"))).toBe(false);
		expect(
			isConnectFailure(
				new Error("canceling statement due to statement timeout"),
			),
		).toBe(false);
		// The turn-write classifier keeps its meaning.
		expect(
			isDroppedConnection(new Error("timeout exceeded when trying to connect")),
		).toBe(false);
	});

	it("repeats twice with 250 ms then 750 ms and logs stage, cause, attempt and pool counts", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const run = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(
				new Error("timeout exceeded when trying to connect"),
			)
			.mockRejectedValueOnce(
				new Error("timeout exceeded when trying to connect"),
			)
			.mockResolvedValueOnce("ok");
		const result = retryConnectFailure(run, {
			stage: "connect",
			stats: () => ({ total: 2, idle: 0, waiting: 3 }),
		});
		await vi.advanceTimersByTimeAsync(249);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(750);
		await expect(result).resolves.toBe("ok");
		expect(warn).toHaveBeenNthCalledWith(
			1,
			"Request database connection failed.",
			{
				stage: "connect",
				code: null,
				message: "timeout exceeded when trying to connect",
				attempt: 1,
				total: 2,
				idle: 0,
				waiting: 3,
			},
		);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
		vi.useRealTimers();
	});

	it("throws the last error after two repeats and never repeats other errors", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = vi.fn(async () => {
			throw new Error("timeout exceeded when trying to connect");
		});
		const done = expect(
			retryConnectFailure(failing, { stage: "query" }),
		).rejects.toThrow("timeout exceeded");
		await vi.advanceTimersByTimeAsync(1000);
		await done;
		expect(failing).toHaveBeenCalledTimes(3);
		const other = vi.fn(async () => {
			throw new Error("duplicate key value");
		});
		await expect(
			retryConnectFailure(other, { stage: "query" }),
		).rejects.toThrow("duplicate");
		expect(other).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		vi.useRealTimers();
	});
});
