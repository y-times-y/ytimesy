import { expect, it } from "vitest";
import { chatListRetry } from "./chat-list-retry";

it("reads a failed chat list again twice, after 1 s and 2 s", () => {
	expect(chatListRetry.retry).toBe(2);
	expect(chatListRetry.retryDelay(0)).toBe(1000);
	expect(chatListRetry.retryDelay(1)).toBe(2000);
});
