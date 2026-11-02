import { expect, it, vi } from "vitest";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	coordinate: vi.fn(),
}));
vi.mock("../adapters/api-turns", () => ({ cancelApiTurn: mocks.cancel }));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: mocks.coordinate,
}));

import { cancelServerTurn } from "./cancel-server-turn";
import { registerLiveTurn } from "./live-turn-abort";

it("aborts a turn running in this process before delivering the stop elsewhere", async () => {
	const order: string[] = [];
	mocks.cancel.mockResolvedValue([{ id: "turn", lease_id: "lease" }]);
	mocks.coordinate.mockImplementation(async () => {
		order.push("coordinator");
		return true;
	});
	const forget = registerLiveTurn("turn", (reason) => {
		expect(reason).toBeInstanceOf(ApiTurnCancelled);
		order.push("aborted");
	});
	try {
		await cancelServerTurn("owner", "chat");
		expect(order).toEqual(["aborted", "coordinator"]);
		expect(mocks.coordinate).toHaveBeenCalledWith("cancel", {
			userId: "owner",
			sessionId: "chat",
			turnId: "turn",
			leaseId: "lease",
		});
	} finally {
		forget();
	}
});
