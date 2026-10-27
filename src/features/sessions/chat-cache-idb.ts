import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import type { ChatCacheMeta, ChatCacheStore } from "./chat-cache";

/**
 * The chat cache in IndexedDB. Metadata and transcripts are separate stores
 * so eviction reads a few bytes per chat, not every transcript.
 */
const DB_NAME = "ytimesy-chat-cache";
const DB_VERSION = 1;
const META = "chatMeta";
const VIEWS = "chatViews";

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function committed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

function openDatabase(): Promise<IDBDatabase> {
	const request = indexedDB.open(DB_NAME, DB_VERSION);
	request.onupgradeneeded = () => {
		const db = request.result;
		if (!db.objectStoreNames.contains(META)) {
			const meta = db.createObjectStore(META, { keyPath: "chatId" });
			meta.createIndex("updatedAtMs", "updatedAtMs");
			meta.createIndex("lastAccessedAtMs", "lastAccessedAtMs");
		}
		if (!db.objectStoreNames.contains(VIEWS))
			db.createObjectStore(VIEWS, { keyPath: "chatId" });
	};
	return done(request).then((db) => {
		// Another tab upgrading the schema: step aside rather than block it.
		db.onversionchange = () => db.close();
		return db;
	});
}

export function indexedDbChatCacheStore(): ChatCacheStore {
	let opening: Promise<IDBDatabase> | undefined;
	const database = () => {
		opening ??= openDatabase();
		// A failed open (private mode, blocked storage) is tried again next time.
		opening.catch(() => {
			opening = undefined;
		});
		return opening;
	};
	const write = async (
		run: (meta: IDBObjectStore, views: IDBObjectStore) => void,
	) => {
		const transaction = (await database()).transaction(
			[META, VIEWS],
			"readwrite",
		);
		run(transaction.objectStore(META), transaction.objectStore(VIEWS));
		await committed(transaction);
	};
	return {
		async metas() {
			const db = await database();
			return done(
				db.transaction(META).objectStore(META).getAll() as IDBRequest<
					ChatCacheMeta[]
				>,
			);
		},
		async get(chatId) {
			const transaction = (await database()).transaction([META, VIEWS]);
			const [meta, stored] = await Promise.all([
				done(
					transaction.objectStore(META).get(chatId) as IDBRequest<
						ChatCacheMeta | undefined
					>,
				),
				done(
					transaction.objectStore(VIEWS).get(chatId) as IDBRequest<
						{ chatId: string; view: PublicCodexSession } | undefined
					>,
				),
			]);
			return meta && stored ? { meta, view: stored.view } : undefined;
		},
		put: (meta, view) =>
			write((metas, views) => {
				metas.put(meta);
				views.put({ chatId: meta.chatId, view });
			}),
		touch: (meta) =>
			write((metas) => {
				// Only a chat still stored: a removal in between stays removed.
				const current = metas.get(meta.chatId);
				current.onsuccess = () => {
					if (current.result) metas.put(meta);
				};
			}),
		remove: (chatIds) =>
			write((metas, views) => {
				for (const id of chatIds) {
					metas.delete(id);
					views.delete(id);
				}
			}),
		clear: () =>
			write((metas, views) => {
				metas.clear();
				views.clear();
			}),
	};
}
