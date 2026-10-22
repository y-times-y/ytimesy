import { afterEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { turnProgressWriter } from "./turn-progress-writer";

const snapshot = (text: string): SessionItem[] => [
	{ kind: "agentMessage", id: SessionItemId("message"), text },
];

it("coalesces pending deltas without concurrent writes and drains the latest snapshot", async () => {
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const write = vi
		.fn()
		.mockImplementationOnce(() => pending)
		.mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.offer(snapshot("first"));
	writer.offer(snapshot("second"));
	writer.offer(snapshot("latest"));
	expect(write).toHaveBeenCalledTimes(1);
	const drained = vi.fn();
	const done = writer.drain().then(drained);
	await Promise.resolve();
	expect(drained).not.toHaveBeenCalled();
	release();
	await done;
	expect(write.mock.calls.map((call) => call[0][0].text)).toEqual([
		"first",
		"latest",
	]);
});

it("remains usable after a drained batch", async () => {
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.offer(snapshot("first"));
	await writer.drain();
	writer.offer(snapshot("next"));
	await writer.drain();
	expect(write).toHaveBeenCalledTimes(2);
});

it("reports storage failure, rejects draining and never writes later stale progress", async () => {
	const error = new Error("Lease lost");
	const write = vi.fn().mockRejectedValue(error);
	const failure = vi.fn();
	const writer = turnProgressWriter(write, failure);
	writer.offer(snapshot("first"));
	writer.offer(snapshot("pending"));
	await expect(writer.drain()).rejects.toBe(error);
	expect(failure).toHaveBeenCalledExactlyOnceWith(error);
	expect(() => writer.offer(snapshot("later"))).toThrow(error);
	expect(write).toHaveBeenCalledTimes(1);
});

it("drops a waiting snapshot a checkpoint supersedes, but finishes the write in flight", async () => {
	let release: () => void = () => {};
	const write = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		)
		.mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.offer(snapshot("in flight"));
	writer.offer(snapshot("waiting"));
	writer.supersede();
	const done = writer.drain();
	release();
	await done;
	expect(write.mock.calls.map((call) => call[0][0].text)).toEqual([
		"in flight",
	]);
	writer.offer(snapshot("after"));
	await writer.drain();
	expect(write).toHaveBeenCalledTimes(2);
});

afterEach(() => {
	vi.useRealTimers();
});

it("writes a throttled snapshot when its window ends, keeping only the newest", async () => {
	vi.useFakeTimers();
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.offerLater(snapshot("first"), 200);
	writer.offerLater(snapshot("newest"), 50);
	await vi.advanceTimersByTimeAsync(199);
	expect(write).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(write.mock.calls.map((call) => call[0][0].text)).toEqual(["newest"]);
});

it("drops a throttled snapshot once a newer offer, a supersede or a drain comes", async () => {
	vi.useFakeTimers();
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.offerLater(snapshot("throttled"), 100);
	writer.offer(snapshot("finish"));
	writer.offerLater(snapshot("superseded"), 100);
	writer.supersede();
	writer.offerLater(snapshot("drained"), 100);
	await writer.drain();
	await vi.advanceTimersByTimeAsync(500);
	expect(write.mock.calls.map((call) => call[0][0].text)).toEqual(["finish"]);
});

it("never writes a throttled snapshot after a storage failure", async () => {
	vi.useFakeTimers();
	const error = new Error("Lease lost");
	const write = vi.fn().mockRejectedValue(error);
	const failure = vi.fn();
	const writer = turnProgressWriter(write, failure);
	writer.offer(snapshot("first"));
	writer.offerLater(snapshot("throttled"), 100);
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(500);
	expect(write).toHaveBeenCalledTimes(1);
	expect(failure).toHaveBeenCalledExactlyOnceWith(error);
	expect(() => writer.offerLater(snapshot("later"), 100)).toThrow(error);
});
