import { describe, expect, it } from "vitest";
import {
	composerDraftKey,
	DRAFT_MAX_AGE_MS,
	draftFromStorage,
	NEW_CHAT_DRAFT_KEY,
	storageWithDraft,
} from "./composer-drafts";

const now = Date.parse("2026-10-24T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("composer drafts", () => {
	it("keeps one draft per chat and one for the new chat", () => {
		let raw = storageWithDraft(
			null,
			"chat-1",
			"fix the build",
			now,
			DRAFT_MAX_AGE_MS,
		);
		raw = storageWithDraft(
			raw,
			NEW_CHAT_DRAFT_KEY,
			"a new idea",
			now,
			DRAFT_MAX_AGE_MS,
		);
		expect(draftFromStorage(raw, "chat-1", now, DRAFT_MAX_AGE_MS)).toBe(
			"fix the build",
		);
		expect(
			draftFromStorage(raw, NEW_CHAT_DRAFT_KEY, now, DRAFT_MAX_AGE_MS),
		).toBe("a new idea");
		expect(draftFromStorage(raw, "chat-2", now, DRAFT_MAX_AGE_MS)).toBe("");
	});

	it("removes a chat's draft when it empties, as a send does", () => {
		const raw = storageWithDraft(
			null,
			"chat-1",
			"hello",
			now,
			DRAFT_MAX_AGE_MS,
		);
		const sent = storageWithDraft(raw, "chat-1", "  ", now, DRAFT_MAX_AGE_MS);
		expect(JSON.parse(sent)).toEqual({});
	});

	it("drops drafts older than about a week", () => {
		const raw = storageWithDraft(
			null,
			"old",
			"stale",
			now - 8 * day,
			DRAFT_MAX_AGE_MS,
		);
		expect(draftFromStorage(raw, "old", now, DRAFT_MAX_AGE_MS)).toBe("");
		const later = storageWithDraft(
			raw,
			"fresh",
			"new text",
			now,
			DRAFT_MAX_AGE_MS,
		);
		expect(Object.keys(JSON.parse(later))).toEqual(["fresh"]);
	});

	it("reads nothing from unreadable storage, and starts it over on save", () => {
		expect(draftFromStorage("{not json", "chat-1", now, DRAFT_MAX_AGE_MS)).toBe(
			"",
		);
		expect(draftFromStorage(null, "chat-1", now, DRAFT_MAX_AGE_MS)).toBe("");
		expect(
			JSON.parse(
				storageWithDraft("[1]", "chat-1", "hi", now, DRAFT_MAX_AGE_MS),
			),
		).toEqual({ "chat-1": { text: "hi", at: now } });
	});

	it("keys a composer by its chat, or the new chat", () => {
		expect(composerDraftKey("chat-1")).toBe("chat-1");
		expect(composerDraftKey(null)).toBe(NEW_CHAT_DRAFT_KEY);
	});
});
