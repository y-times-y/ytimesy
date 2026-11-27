import { describe, expect, it } from "vitest";
import {
	parseSuggestionPref,
	RETURNING_CHAT_THRESHOLD,
	threadSuggestionsState,
} from "./thread-suggestions";

const fresh = { pref: null, projectCount: 1, chatCount: 0, superAgent: false };

describe("threadSuggestionsState", () => {
	it("shows them to a brand-new user in the first project", () => {
		expect(threadSuggestionsState(fresh)).toBe("shown");
	});
	it("hides them for a returning user (many chats) but offers the quiet link", () => {
		expect(
			threadSuggestionsState({
				...fresh,
				chatCount: RETURNING_CHAT_THRESHOLD + 1,
			}),
		).toBe("offer");
	});
	it("treats a second project as returning", () => {
		expect(threadSuggestionsState({ ...fresh, projectCount: 2 })).toBe("offer");
	});
	it("keeps them at exactly the threshold", () => {
		expect(
			threadSuggestionsState({ ...fresh, chatCount: RETURNING_CHAT_THRESHOLD }),
		).toBe("shown");
	});
	it("honours 'Don't show again' even for a new user, with the link to undo", () => {
		expect(threadSuggestionsState({ ...fresh, pref: "hide" })).toBe("offer");
	});
	it("honours 'show again' for a returning user", () => {
		expect(
			threadSuggestionsState({
				...fresh,
				pref: "show",
				chatCount: 50,
				projectCount: 4,
			}),
		).toBe("shown");
	});
	it("never shows or offers them in the Super agent chat", () => {
		expect(threadSuggestionsState({ ...fresh, superAgent: true })).toBe("none");
		expect(
			threadSuggestionsState({ ...fresh, superAgent: true, pref: "show" }),
		).toBe("none");
	});
});

describe("parseSuggestionPref", () => {
	it("accepts only known values", () => {
		expect(parseSuggestionPref("hide")).toBe("hide");
		expect(parseSuggestionPref("show")).toBe("show");
		expect(parseSuggestionPref("x")).toBeNull();
		expect(parseSuggestionPref(null)).toBeNull();
	});
});
