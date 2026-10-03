import { beforeEach, expect, it, vi } from "vitest";
import {
	drainConversationDeliveries,
	relayConversationDeliveries,
} from "./conversation-delivery";

const fake = vi.hoisted(() => ({
	claim: vi.fn(),
	settle: vi.fn(),
	publish: vi.fn(),
}));
vi.mock("../adapters/conversation-delivery", () => ({
	claimConversationDeliveries: fake.claim,
	settleConversationDelivery: fake.settle,
}));
vi.mock("../adapters/realtime-delivery", () => ({
	realtimeDeliveryConfiguration: () => ({ url: "fixture" }),
	publishConversationSnapshot: fake.publish,
}));
beforeEach(() => {
	vi.clearAllMocks();
	fake.settle.mockResolvedValue(undefined);
});
it("continues claiming healthy conversations while one relay request is stalled", async () => {
	let fail: (value: boolean) => void = () => {};
	const stalled = { snapshot: { sessionId: "stalled" }, leaseId: "one" };
	const healthy = { snapshot: { sessionId: "healthy" }, leaseId: "two" };
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
