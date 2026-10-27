import { describe, expect, it } from "vitest";
import type { SessionItem } from "#/domain/session-item";
import { TRANSCRIPT_PAGE_TURNS } from "#/domain/transcript-page";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	CHAT_CACHE_VERSION,
	ChatCache,
	type ChatCacheMeta,
	type ChatCacheStore,
	chatsToEvict,
} from "./chat-cache";

function memoryStore(): ChatCacheStore & {
	entries: Map<string, { meta: ChatCacheMeta; view: PublicCodexSession }>;
} {
	const entries = new Map<
		string,
		{ meta: ChatCacheMeta; view: PublicCodexSession }
	>();
	return {
		entries,
		metas: async () => [...entries.values()].map((entry) => entry.meta),
		get: async (chatId) => entries.get(chatId),
		put: async (meta, view) => {
			entries.set(meta.chatId, { meta, view });
		},
		touch: async (meta) => {
			const entry = entries.get(meta.chatId);
			if (entry) entries.set(meta.chatId, { ...entry, meta });
		},
		remove: async (ids) => {
			for (const id of ids) entries.delete(id);
		},
		clear: async () => entries.clear(),
	};
}

function failingStore(): ChatCacheStore {
	const fail = async () => {
		throw new DOMException("blocked", "SecurityError");
	};
	return {
		metas: fail,
		get: fail,
		put: fail,
		touch: fail,
		remove: fail,
		clear: fail,
	};
}

const user = (id: string): SessionItem => ({
	kind: "userMessage",
	id: id as never,
	text: id,
});

function view(
	chatId: string,
	overrides: Partial<PublicCodexSession> = {},
): PublicCodexSession {
	return {
		snapshotAvailable: false,
		workspaceId: "w",
		agentSessionId: chatId,
		connection: {
			status: "authenticated",
			provider: "codex",
			authMode: "chatgpt",
			planType: null,
			email: null,
		},
		models: [],
		listedModelId: "",
		blockedListedModelIds: [],
		canSend: true,
		turnStatus: "completed",
		items: [user(`${chatId}-1`)],
		...overrides,
	};
}

function cache(
	store: ChatCacheStore | null,
	owner = "user-1",
	options: ConstructorParameters<typeof ChatCache>[2] = {},
) {
	let clock = 1_000;
	return new ChatCache(store, owner, {
		now: () => clock++,
		coalesceMs: 60_000,
		...options,
	});
}

describe("chat cache", () => {
	it("returns a written chat, unable to send until the server answers", async () => {
		const store = memoryStore();
		const chats = cache(store);
		chats.write("p", view("a", { turnStatus: "running" }));
		await chats.flush();
		const restored = await chats.read("a");
		expect(restored?.items.map((item) => item.id)).toEqual(["a-1"]);
		expect(restored?.canSend).toBe(false);
		expect(restored?.turnStatus).toBe("idle");
		expect(await chats.read("missing")).toBeUndefined();
	});

	it("writes the latest view once when several arrive together", async () => {
		const store = memoryStore();
		const chats = cache(store);
		chats.write("p", view("a", { items: [user("old")] }));
		chats.write("p", view("a", { items: [user("new")] }));
		await chats.flush();
		expect(store.entries.get("a")?.view.items.map((item) => item.id)).toEqual([
			"new",
		]);
	});

	it("keeps only the latest page and never a pending sign-in code", async () => {
		const store = memoryStore();
		const chats = cache(store);
		const items = Array.from({ length: TRANSCRIPT_PAGE_TURNS + 5 }, (_, n) =>
			user(`u${n}`),
		);
		chats.write(
			"p",
			view("a", {
				items,
				connection: {
					status: "awaiting_device_code",
					provider: "codex",
					loginId: "l",
					verificationUrl: "https://example.test",
					userCode: "SECRET",
				},
			}),
		);
		await chats.flush();
		const stored = store.entries.get("a")?.view;
		expect(stored?.items).toHaveLength(TRANSCRIPT_PAGE_TURNS);
		expect(stored?.hasOlderItems).toBe(true);
		expect(stored?.connection).toEqual({ status: "disconnected" });
	});

	it("records access times, so reading a chat keeps it from eviction", async () => {
		const store = memoryStore();
		const chats = cache(store, "user-1", { maxChats: 2 });
		chats.write("p", view("a"));
		chats.write("p", view("b"));
		await chats.flush();
		await chats.read("a");
		chats.write("p", view("c"));
		await chats.flush();
		expect([...store.entries.keys()].sort()).toEqual(["a", "c"]);
	});

	it("drops another user's chats before reading", async () => {
		const store = memoryStore();
		const first = cache(store, "user-1");
		first.write("p", view("a"));
		await first.flush();
		const second = cache(store, "user-2");
		expect(await second.read("a")).toBeUndefined();
		expect(store.entries.size).toBe(0);
	});

	it("drops entries of another schema version", async () => {
		const store = memoryStore();
		await store.put(
			{
				chatId: "a",
				ownerId: "user-1",
				projectId: "p",
				version: CHAT_CACHE_VERSION - 1,
				updatedAtMs: 1,
				lastAccessedAtMs: 1,
				bytes: 10,
			},
			view("a"),
		);
		expect(await cache(store).read("a")).toBeUndefined();
		expect(store.entries.size).toBe(0);
	});

	it("forgets deleted chats and chats the server no longer lists", async () => {
		const store = memoryStore();
		const chats = cache(store);
		chats.write("p", view("a"));
		chats.write("p", view("b"));
		chats.write("q", view("c"));
		await chats.flush();
		await chats.forget(["a"]);
		await chats.keepOnly("p", []);
		expect([...store.entries.keys()]).toEqual(["c"]);
	});

	it("writes nothing pending once closed (signed out)", async () => {
		const store = memoryStore();
		const chats = cache(store);
		chats.write("p", view("a"));
		chats.close();
		await chats.flush();
		expect(store.entries.size).toBe(0);
	});

	it("misses quietly when storage is unavailable or blocked", async () => {
		for (const store of [null, failingStore()]) {
			const chats = cache(store);
			chats.write("p", view("a"));
			await expect(chats.flush()).resolves.toBeUndefined();
			await expect(chats.read("a")).resolves.toBeUndefined();
			await expect(chats.forget(["a"])).resolves.toBeUndefined();
			await expect(chats.keepOnly("p", [])).resolves.toBeUndefined();
		}
	});
});

describe("eviction", () => {
	const meta = (chatId: string, lastAccessedAtMs: number, bytes = 1) => ({
		chatId,
		ownerId: "u",
		projectId: "p",
		version: CHAT_CACHE_VERSION,
		updatedAtMs: 0,
		lastAccessedAtMs,
		bytes,
	});

	it("evicts the least recently opened chats past the count limit", () => {
		expect(
			chatsToEvict([meta("a", 3), meta("b", 1), meta("c", 2)], {
				maxChats: 1,
				maxBytes: 100,
			}),
		).toEqual(["b", "c"]);
	});

	it("evicts past the size limit, whichever limit comes first", () => {
		expect(
			chatsToEvict([meta("a", 1, 60), meta("b", 2, 30), meta("c", 3, 30)], {
				maxChats: 10,
				maxBytes: 70,
			}),
		).toEqual(["a"]);
	});
});
