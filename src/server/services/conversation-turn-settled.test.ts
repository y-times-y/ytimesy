import { beforeEach, expect, it, vi } from "vitest";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	holdSettledConversationTurn,
	TURN_HOLD_LOST,
	TURN_STILL_FINISHING,
} from "./conversation-turn-settled";

vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(),
}));
const coordinate = vi.mocked(coordinateConversationTurn);
const session = "00000000-0000-4000-8000-000000000001";

beforeEach(() => coordinate.mockReset());

it("refuses while a stopped turn still holds the chat's coordination lease", async () => {
	coordinate.mockResolvedValueOnce(false);
	await expect(holdSettledConversationTurn("alice", session)).rejects.toThrow(
		TURN_STILL_FINISHING,
	);
	expect(coordinate).toHaveBeenCalledOnce();
	expect(coordinate.mock.calls[0][0]).toBe("acquire");
});

it("holds the lease under a fresh identity and releases that same identity", async () => {
	coordinate.mockResolvedValue(true);
	const hold = await holdSettledConversationTurn("alice", session);
	const [action, held] = coordinate.mock.calls[0];
	expect(action).toBe("acquire");
	expect(held).toMatchObject({ userId: "alice", sessionId: session });
	await hold.release();
	expect(coordinate).toHaveBeenLastCalledWith("release", held);
});

it("refuses when the coordinator cannot confirm the turn settled", async () => {
	coordinate.mockRejectedValueOnce(new Error("timeout"));
	await expect(holdSettledConversationTurn("alice", session)).rejects.toThrow(
		/Could not confirm the last turn has finished/,
	);
});

it("renews the hold while a long restore runs and stops renewing once released", async () => {
	vi.useFakeTimers();
	try {
		coordinate.mockResolvedValue(true);
		const hold = await holdSettledConversationTurn("alice", session);
		const held = coordinate.mock.calls[0][1];
		await vi.advanceTimersByTimeAsync(65_000);
		const renewals = coordinate.mock.calls.filter(([a]) => a === "renew");
		expect(renewals).toHaveLength(6);
		for (const [, turn] of renewals) expect(turn).toEqual(held);
		expect(() => hold.assertHeld()).not.toThrow();
		await hold.release();
		await hold.release();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(coordinate.mock.calls.filter(([a]) => a === "renew")).toHaveLength(
			6,
		);
		expect(coordinate.mock.calls.filter(([a]) => a === "release")).toHaveLength(
			1,
		);
	} finally {
		vi.useRealTimers();
	}
});

it("reports a lost hold when a renewal is refused or fails", async () => {
	vi.useFakeTimers();
	try {
		coordinate.mockImplementation(async (action) => action !== "renew");
		const hold = await holdSettledConversationTurn("alice", session);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(() => hold.assertHeld()).toThrow(TURN_HOLD_LOST);
		await hold.release();
	} finally {
		vi.useRealTimers();
	}
});

it("retries a failed release so new turns are not blocked for a lease period", async () => {
	vi.useFakeTimers();
	try {
		coordinate
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce(true);
		const hold = await holdSettledConversationTurn("alice", session);
		const released = hold.release();
		await vi.advanceTimersByTimeAsync(250);
		await released;
		expect(coordinate.mock.calls.filter(([a]) => a === "release")).toHaveLength(
			2,
		);
	} finally {
		vi.useRealTimers();
	}
});
