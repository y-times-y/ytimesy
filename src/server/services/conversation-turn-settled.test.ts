import { beforeEach, expect, it, vi } from "vitest";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	holdSettledConversationTurn,
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
	const release = await holdSettledConversationTurn("alice", session);
	const [action, held] = coordinate.mock.calls[0];
	expect(action).toBe("acquire");
	expect(held).toMatchObject({ userId: "alice", sessionId: session });
	await release();
	expect(coordinate).toHaveBeenLastCalledWith("release", held);
});

it("refuses when the coordinator cannot confirm the turn settled", async () => {
	coordinate.mockRejectedValueOnce(new Error("timeout"));
	await expect(holdSettledConversationTurn("alice", session)).rejects.toThrow(
		/Could not confirm the last turn has finished/,
	);
});
