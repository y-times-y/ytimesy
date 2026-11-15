import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => vi.fn());
vi.mock("./queued-user-messages", () => ({ sendComposerMessage: send }));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: session,
}));

import { pushedMessageText, wakeChatAfterPush } from "./push-approval-wake";

const input = {
	userId: "u",
	sessionId: "s",
	cardId: "card-1",
	detail: "abc1234",
};

beforeEach(() => {
	send.mockReset().mockReturnValue(Effect.succeed({}));
	session.mockReset().mockResolvedValue({
		id: "s",
		projectId: "p",
		harness: "codex",
		listedModelId: "gpt-6.1-sol",
	});
});

describe("wakeChatAfterPush", () => {
	it("sends the chat a message under an id that is stable per card", async () => {
		await wakeChatAfterPush({} as never, input);
		await wakeChatAfterPush({} as never, input);
		const [first, second] = send.mock.calls.map(
			([, , message]) => message.idempotencyKey,
		);
		expect(first).toBe(second);
		expect(send.mock.calls[0]?.[2].text).toBe(pushedMessageText(input));
		expect(send.mock.calls[0]?.[2].modelId).toBe("gpt-6.1-sol");
	});

	it("never throws when the chat cannot be woken", async () => {
		send.mockReturnValue(Effect.fail(new Error("no")));
		await expect(
			wakeChatAfterPush({} as never, input),
		).resolves.toBeUndefined();
		session.mockResolvedValue(null);
		await expect(
			wakeChatAfterPush({} as never, input),
		).resolves.toBeUndefined();
	});
});
