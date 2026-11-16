import { afterEach, expect, it, vi } from "vitest";
import {
	CONVERSATION_FORK_UNAVAILABLE,
	conversationForkEnabled,
} from "#/domain/conversation-fork";
import { RecoveryRefused } from "#/domain/conversation-recovery-failure";
import { recoverConversation } from "./conversation-recovery";

afterEach(() => vi.unstubAllEnvs());

const request = {
	projectId: "00000000-0000-4000-8000-000000000001",
	sessionId: "00000000-0000-4000-8000-000000000002",
	messageId: "message",
	mode: "fork",
} as const;

it("starts a fork only when YTIMESY_CONVERSATION_FORK_ENABLED is 1", () => {
	expect(conversationForkEnabled({})).toBe(false);
	expect(
		conversationForkEnabled({ YTIMESY_CONVERSATION_FORK_ENABLED: "0" }),
	).toBe(false);
	expect(
		conversationForkEnabled({ YTIMESY_CONVERSATION_FORK_ENABLED: "1" }),
	).toBe(true);
});

it("refuses a new fork with a message the user sees, before touching any machine", async () => {
	vi.stubEnv("YTIMESY_CONVERSATION_FORK_ENABLED", "");
	const machines = new Proxy(
		{},
		{
			get() {
				throw new Error("a refused fork must not touch a machine");
			},
		},
	);
	const refusal = await recoverConversation(
		machines as never,
		"00000000-0000-4000-8000-000000000003",
		request,
	).catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(RecoveryRefused);
	expect((refusal as Error).message).toBe(CONVERSATION_FORK_UNAVAILABLE);
});
