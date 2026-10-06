import { expect, it, vi } from "vitest";
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
