import { afterEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { REVEAL_CATCH_UP_MS } from "#/domain/smooth-reveal";
import {
	PROGRESS_WINDOW_MS,
	progressWindowMs,
	turnProgressWriter,
} from "./turn-progress-writer";

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

it("does not write the array a checkpoint stored, or the same array twice", async () => {
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	const stored = snapshot("stored");
	writer.markStored(stored);
	writer.offer(stored);
	await writer.drain();
	expect(write).not.toHaveBeenCalled();
	const next = snapshot("next");
	writer.offer(next);
	await writer.drain();
	writer.offer(next);
	await writer.drain();
	expect(write).toHaveBeenCalledTimes(1);
});

/** The stream throttle of api-turn.ts: a delta writes now, or when the window ends. */
async function streamWrites(windowMs: number, seconds: number) {
	vi.useFakeTimers();
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	let text = "";
	for (let t = 0; t < seconds * 1000; t += 40) {
		text += "word ";
		writer.stream(snapshot(text), windowMs);
		await vi.advanceTimersByTimeAsync(40);
	}
	await vi.advanceTimersByTimeAsync(windowMs);
	return write;
}

it("delivers continuous output within the reveal catch-up time while coalescing deltas", async () => {
	expect(PROGRESS_WINDOW_MS).toBeLessThanOrEqual(REVEAL_CATCH_UP_MS);
	const write = await streamWrites(PROGRESS_WINDOW_MS, 20);
	// 500 model deltas need about 80 snapshots, not one write per token.
	expect(write.mock.calls.length).toBeGreaterThanOrEqual(80);
	expect(write.mock.calls.length).toBeLessThanOrEqual(81);
	const last = write.mock.calls.at(-1)?.[0][0];
	expect(last.text.split(" ").length - 1).toBe(500);
});

it("delivers the first delta immediately and the newest tail on time without another model event", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
	const write = vi.fn().mockResolvedValue(undefined);
	const writer = turnProgressWriter(write, vi.fn());
	writer.stream(snapshot("Bonjour"), PROGRESS_WINDOW_MS);
	expect(write).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(40);
	writer.stream(snapshot("Bonjour le"), PROGRESS_WINDOW_MS);
	await vi.advanceTimersByTimeAsync(40);
	writer.stream(snapshot("Bonjour le monde 🌍"), PROGRESS_WINDOW_MS);
	await vi.advanceTimersByTimeAsync(PROGRESS_WINDOW_MS - 81);
	expect(write).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(write.mock.calls.map((call) => call[0][0].text)).toEqual([
		"Bonjour",
		"Bonjour le monde 🌍",
	]);
	await writer.drain();
});

it("sizes the window to the snapshot: short for a small chat, longer for a big one, capped", () => {
	expect(progressWindowMs(20_000)).toBe(PROGRESS_WINDOW_MS);
	expect(progressWindowMs(0)).toBe(PROGRESS_WINDOW_MS);
	expect(progressWindowMs(480_000)).toBeGreaterThan(1_000);
	expect(progressWindowMs(480_000)).toBeLessThan(1_500);
	expect(progressWindowMs(5_000_000)).toBe(1_500);
});

it("widens its stream window after writing a big snapshot", async () => {
	const writer = turnProgressWriter(
		async () => 900_000,
		() => {},
	);
	expect(writer.window()).toBe(PROGRESS_WINDOW_MS);
	writer.offer(snapshot("first"));
	await writer.drain();
	expect(writer.window()).toBe(1_500);
});
