import { describe, expect, it } from "vitest";
import {
	RETURNING_CHAT_THRESHOLD,
	showThreadSuggestions,
} from "./thread-suggestions";

const fresh = { projectCount: 1, chatCount: 0, superAgent: false };

describe("showThreadSuggestions", () => {
	it("shows them to a brand-new user in the first project", () => {
		expect(showThreadSuggestions(fresh)).toBe(true);
	});
	it("hides them for a returning user (many chats)", () => {
		expect(
			showThreadSuggestions({
				...fresh,
				chatCount: RETURNING_CHAT_THRESHOLD + 1,
			}),
		).toBe(false);
	});
	it("treats a second project as returning", () => {
		expect(showThreadSuggestions({ ...fresh, projectCount: 2 })).toBe(false);
	});
	it("keeps them at exactly the threshold", () => {
		expect(
			showThreadSuggestions({ ...fresh, chatCount: RETURNING_CHAT_THRESHOLD }),
		).toBe(true);
	});
	it("never shows them in the Super agent chat", () => {
		expect(showThreadSuggestions({ ...fresh, superAgent: true })).toBe(false);
	});
});
