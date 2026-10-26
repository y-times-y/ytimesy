import { describe, expect, it } from "vitest";
import {
	composerDraftKey,
	createDraftSaver,
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

describe("draft saver", () => {
	function saver() {
		const saved: [string, string][] = [];
		const timers = new Map<number, () => void>();
		let next = 0;
		const drafts = createDraftSaver(
			(chatKey, text) => saved.push([chatKey, text]),
			300,
			{
				set: (run) => {
					timers.set(++next, run);
					return next;
				},
				clear: (timer) => timers.delete(timer as number),
			},
		);
		const elapse = () => {
			for (const [id, run] of [...timers]) {
				timers.delete(id);
				run();
			}
		};
		return { drafts, saved, elapse, timers };
	}

	it("saves once typing pauses, under the chat it was typed in", () => {
		const { drafts, saved, elapse } = saver();
		drafts.typed("chat-1", "fi");
		drafts.typed("chat-1", "fix");
		expect(saved).toEqual([]);
		elapse();
		expect(saved).toEqual([["chat-1", "fix"]]);
	});

	it("saves a pending draft under its own chat when a new chat gets its id", () => {
		const { drafts, saved, elapse, timers } = saver();
		// Typed in the new-chat composer; New chat's chat gets its id before the debounce fires.
		drafts.typed(NEW_CHAT_DRAFT_KEY, "half a thought");
		drafts.flush();
		expect(saved).toEqual([[NEW_CHAT_DRAFT_KEY, "half a thought"]]);
		expect(timers.size).toBe(0);
		drafts.typed("chat-2", "half a thought, finished");
		elapse();
		expect(saved).toEqual([
			[NEW_CHAT_DRAFT_KEY, "half a thought"],
			["chat-2", "half a thought, finished"],
		]);
	});

	it("never moves pending text to the next chat typed in", () => {
		const { drafts, saved, elapse } = saver();
		drafts.typed("chat-1", "for chat one");
		drafts.typed("chat-2", "for chat two");
		expect(saved).toEqual([["chat-1", "for chat one"]]);
		elapse();
		expect(saved).toEqual([
			["chat-1", "for chat one"],
			["chat-2", "for chat two"],
		]);
	});

	it("clears at once on a send and drops the pending text", () => {
		const { drafts, saved, elapse } = saver();
		drafts.typed("chat-1", "send me");
		drafts.typed("chat-1", "");
		elapse();
		expect(saved).toEqual([["chat-1", ""]]);
	});
});
