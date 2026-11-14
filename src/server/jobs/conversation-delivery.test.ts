import { beforeEach, expect, it, vi } from "vitest";
import {
	drainConversationDeliveries,
	relayConversationDeliveries,
} from "./conversation-delivery";

const fake = vi.hoisted(() => ({
	claim: vi.fn(),
	settle: vi.fn(),
	publish: vi.fn(),
	snapshot: vi.fn(),
}));
vi.mock("../adapters/conversation-delivery", () => ({
	claimConversationDeliveries: fake.claim,
	settleConversationDelivery: fake.settle,
	conversationSnapshot: fake.snapshot,
}));
vi.mock("../adapters/realtime-delivery", () => ({
	realtimeDeliveryConfiguration: () => ({ url: "fixture" }),
	publishConversationUpdate: fake.publish,
}));
beforeEach(() => {
	vi.clearAllMocks();
	fake.settle.mockResolvedValue(undefined);
});
it("continues claiming healthy conversations while one relay request is stalled", async () => {
	let fail: (value: boolean) => void = () => {};
	const stalled = { update: { sessionId: "stalled" }, leaseId: "one" };
	const healthy = { update: { sessionId: "healthy" }, leaseId: "two" };
	fake.claim.mockResolvedValueOnce([stalled]).mockResolvedValueOnce([healthy]);
	fake.publish
		.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					fail = resolve;
				}),
		)
		.mockResolvedValueOnce(true);
	await relayConversationDeliveries();
	await relayConversationDeliveries();
	await vi.waitFor(() =>
		expect(fake.settle).toHaveBeenCalledWith(healthy, true),
	);
	expect(fake.claim).toHaveBeenNthCalledWith(2, 15);
	fail(false);
	await drainConversationDeliveries();
	expect(fake.settle).toHaveBeenCalledWith(stalled, false);
});
it("sends the full snapshot at once when the room cannot merge the delta, and settles that one", async () => {
	const delta = {
		update: { kind: "delta", userId: "alice", sessionId: "s", revision: "9" },
		leaseId: "lease",
	};
	const full = { userId: "alice", sessionId: "s", revision: "10" };
	fake.claim.mockResolvedValueOnce([delta]);
	fake.publish.mockResolvedValueOnce("resync").mockResolvedValueOnce(true);
	fake.snapshot.mockResolvedValueOnce(full);
	await relayConversationDeliveries();
	await drainConversationDeliveries();
	expect(fake.snapshot).toHaveBeenCalledWith("alice", "s");
	expect(fake.publish).toHaveBeenNthCalledWith(2, full);
	expect(fake.settle).toHaveBeenCalledWith(
		{ update: full, leaseId: "lease" },
		true,
	);
});
