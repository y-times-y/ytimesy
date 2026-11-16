import { expect, it } from "vitest";
import { chatIsRefreshing } from "./chat-refresh";

it("is refreshing only while the saved copy is shown and the server's read is under way", () => {
	const base = { shown: true, firstReadPending: true, reading: true };
	expect(chatIsRefreshing(base)).toBe(true);
	expect(chatIsRefreshing({ ...base, shown: false })).toBe(false);
	expect(chatIsRefreshing({ ...base, firstReadPending: false })).toBe(false);
	expect(chatIsRefreshing({ ...base, reading: false })).toBe(false);
});
