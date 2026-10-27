import { latestTranscriptPage } from "#/domain/transcript-page";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { indexedDbChatCacheStore } from "./chat-cache-idb";

/**
 * The browser's copy of chats the signed-in user opened: each chat's latest
 * page as the server last sent it. Switching to a chat (after a reload, or
 * on a slow network) shows this copy at once; the server's read replaces it.
 * It never feeds the server-rendered page, so hydration is unaffected.
 *
 * Every storage call can fail (private mode, blocked storage, quota): the
 * cache then misses, and the app behaves as it does without one.
 */

/** Bumped when the stored shape changes; entries of another version are dropped. */
export const CHAT_CACHE_VERSION = 1;
export const CHAT_CACHE_MAX_CHATS = 50;
export const CHAT_CACHE_MAX_BYTES = 25 * 1024 * 1024;
/** Views arriving within this window are written once. */
const WRITE_COALESCE_MS = 500;

/** What eviction and ownership checks read, without the transcript. */
export type ChatCacheMeta = {
	readonly chatId: string;
	readonly ownerId: string;
	readonly projectId: string;
	readonly version: number;
	readonly updatedAtMs: number;
	readonly lastAccessedAtMs: number;
	/** The stored view's JSON length: an estimate of its size. */
	readonly bytes: number;
};

/** Where entries live: IndexedDB in the browser, memory in tests. */
export interface ChatCacheStore {
	metas(): Promise<ChatCacheMeta[]>;
	get(
		chatId: string,
	): Promise<{ meta: ChatCacheMeta; view: PublicCodexSession } | undefined>;
	put(meta: ChatCacheMeta, view: PublicCodexSession): Promise<void>;
	/** Rewrites only the metadata (a read moves lastAccessedAtMs). */
	touch(meta: ChatCacheMeta): Promise<void>;
	remove(chatIds: readonly string[]): Promise<void>;
	clear(): Promise<void>;
}

/** Least recently opened first, until both limits hold. */
export function chatsToEvict(
	metas: readonly ChatCacheMeta[],
	limits: { maxChats: number; maxBytes: number },
): string[] {
	const byAccess = [...metas].sort(
		(a, b) => a.lastAccessedAtMs - b.lastAccessedAtMs,
	);
	let count = byAccess.length;
	let bytes = byAccess.reduce((sum, meta) => sum + meta.bytes, 0);
	const evicted: string[] = [];
	for (const meta of byAccess) {
		if (count <= limits.maxChats && bytes <= limits.maxBytes) break;
		evicted.push(meta.chatId);
		count -= 1;
		bytes -= meta.bytes;
	}
	return evicted;
}

/** The view as stored: its latest page, and no pending sign-in code. */
export function storedChatView(view: PublicCodexSession): PublicCodexSession {
	const page = latestTranscriptPage(view.items);
	return {
		...view,
		items: page.items,
		hasOlderItems: Boolean(view.hasOlderItems) || page.hasOlderItems,
		connection:
			view.connection.status === "awaiting_device_code"
				? { status: "disconnected" }
				: view.connection,
	};
}

/**
 * A stored view as shown before the server answers: it cannot send and no
 * turn shows as running, so nothing acts on it and the server's view always
 * replaces it (a running turn's view only gives way to the same turn).
 */
export function restoredChatView(view: PublicCodexSession): PublicCodexSession {
	return {
		...view,
		canSend: false,
		turnStatus: view.turnStatus === "running" ? "idle" : view.turnStatus,
	};
}

export class ChatCache {
	private readonly pending = new Map<
		string,
		{ projectId: string; view: PublicCodexSession }
	>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ready: Promise<void> | undefined;
	private closed = false;

	constructor(
		private readonly store: ChatCacheStore | null,
		readonly ownerId: string,
		private readonly options: {
			maxChats?: number;
			maxBytes?: number;
			now?: () => number;
			coalesceMs?: number;
		} = {},
	) {}

	/** Drops what another user or another version stored; runs before anything else. */
	private claim(): Promise<void> {
		this.ready ??= this.attempt(async (store) => {
			const metas = await store.metas();
			if (metas.some((meta) => meta.ownerId !== this.ownerId)) {
				await store.clear();
				return;
			}
			const stale = metas
				.filter((meta) => meta.version !== CHAT_CACHE_VERSION)
				.map((meta) => meta.chatId);
			if (stale.length) await store.remove(stale);
		}).then(() => undefined);
		return this.ready;
	}

	private now() {
		return (this.options.now ?? Date.now)();
	}

	private async attempt<T>(
		run: (store: ChatCacheStore) => Promise<T>,
	): Promise<T | undefined> {
		if (!this.store) return undefined;
		try {
			return await run(this.store);
		} catch {
			return undefined;
		}
	}

	/** The chat's stored view, ready to show until the server's arrives. */
	async read(chatId: string): Promise<PublicCodexSession | undefined> {
		await this.claim();
		return this.attempt(async (store) => {
			const entry = await store.get(chatId);
			if (!entry) return undefined;
			const { meta, view } = entry;
			if (
				meta.ownerId !== this.ownerId ||
				meta.version !== CHAT_CACHE_VERSION ||
				view.agentSessionId !== chatId
			) {
				await store.remove([chatId]);
				return undefined;
			}
			await store.touch({ ...meta, lastAccessedAtMs: this.now() });
			return restoredChatView(view);
		});
	}

	/** Keeps a view the server sent; views close together are written once. */
	write(projectId: string, view: PublicCodexSession): void {
		if (!this.store || this.closed || !view.agentSessionId) return;
		this.pending.set(view.agentSessionId, { projectId, view });
		if (this.timer !== undefined) return;
		this.timer = setTimeout(
			() => void this.flush(),
			this.options.coalesceMs ?? WRITE_COALESCE_MS,
		);
	}

	/** Writes the pending views now (also when the page is hidden). */
	async flush(): Promise<void> {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.pending.size || this.closed) return;
		const writes = [...this.pending.values()];
		this.pending.clear();
		await this.claim();
		await this.attempt(async (store) => {
			const now = this.now();
			for (const { projectId, view } of writes) {
				if (this.closed) return;
				const stored = storedChatView(view);
				const chatId = stored.agentSessionId as string;
				await store.put(
					{
						chatId,
						ownerId: this.ownerId,
						projectId,
						version: CHAT_CACHE_VERSION,
						updatedAtMs: now,
						lastAccessedAtMs: now,
						bytes: JSON.stringify(stored).length,
					},
					stored,
				);
			}
			const evicted = chatsToEvict(await store.metas(), {
				maxChats: this.options.maxChats ?? CHAT_CACHE_MAX_CHATS,
				maxBytes: this.options.maxBytes ?? CHAT_CACHE_MAX_BYTES,
			});
			if (evicted.length) await store.remove(evicted);
		});
	}

	/** Stops writing: the user signed out or another signed in. */
	close(): void {
		this.closed = true;
		this.pending.clear();
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Chats deleted, or gone on the server. */
	async forget(chatIds: readonly string[]): Promise<void> {
		for (const id of chatIds) this.pending.delete(id);
		if (!chatIds.length) return;
		await this.claim();
		await this.attempt((store) => store.remove(chatIds));
	}

	/** The server listed the project's chats: stored ones not listed are gone. */
	async keepOnly(projectId: string, listedIds: Iterable<string>) {
		const listed = new Set(listedIds);
		await this.claim();
		const gone = await this.attempt(async (store) =>
			(await store.metas())
				.filter((meta) => meta.projectId === projectId)
				.map((meta) => meta.chatId)
				.filter((id) => !listed.has(id)),
		);
		if (gone?.length) await this.forget(gone);
	}
}

let browserStore: ChatCacheStore | null | undefined;
let browserCache: ChatCache | undefined;

function chatCacheStore(): ChatCacheStore | null {
	if (browserStore !== undefined) return browserStore;
	browserStore =
		typeof indexedDB === "undefined" ? null : indexedDbChatCacheStore();
	return browserStore;
}

/** The signed-in user's cache; on the server, a cache that never hits. */
export function chatCacheFor(ownerId: string): ChatCache {
	if (typeof window === "undefined") return new ChatCache(null, ownerId);
	if (browserCache?.ownerId !== ownerId) {
		browserCache?.close();
		browserCache = new ChatCache(chatCacheStore(), ownerId);
	}
	return browserCache;
}

/** Signing out (or deleting the account) leaves no chat in the browser. */
export async function clearChatCache(): Promise<void> {
	browserCache?.close();
	browserCache = undefined;
	if (typeof window === "undefined") return;
	const store = chatCacheStore();
	try {
		await store?.clear();
	} catch {}
}
