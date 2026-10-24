/**
 * The last file tree Files showed for a chat, and the file it had open, kept
 * in this browser so Files can show them the moment it opens (before the
 * server answers). File contents are never stored here. Storage can be
 * missing or throw (private mode, blocked site data); Files then just waits.
 */
const PREFIX = "ytimesy.files.";
const INDEX_KEY = `${PREFIX}recent`;
const MAX_CHATS = 12;
const MAX_PATHS = 4000;

export type FilesSnapshot = {
	readonly root: string | null;
	readonly paths: readonly string[];
	readonly opened?: string;
};

export function readFilesSnapshot(
	sessionId: string | undefined,
): FilesSnapshot | undefined {
	if (!sessionId) return undefined;
	try {
		const raw = window.localStorage.getItem(PREFIX + sessionId);
		if (!raw) return undefined;
		const value = JSON.parse(raw) as Partial<FilesSnapshot>;
		if (!Array.isArray(value.paths)) return undefined;
		return {
			root: typeof value.root === "string" ? value.root : null,
			paths: value.paths.filter((path) => typeof path === "string"),
			opened: typeof value.opened === "string" ? value.opened : undefined,
		};
	} catch {
		return undefined;
	}
}

export function saveFilesSnapshot(
	sessionId: string | undefined,
	next: Partial<FilesSnapshot>,
) {
	if (!sessionId) return;
	try {
		const current = readFilesSnapshot(sessionId);
		const snapshot: FilesSnapshot = {
			root: next.root !== undefined ? next.root : (current?.root ?? null),
			paths: (next.paths ?? current?.paths ?? []).slice(0, MAX_PATHS),
			opened: next.opened ?? current?.opened,
		};
		if (
			current &&
			current.root === snapshot.root &&
			current.opened === snapshot.opened &&
			current.paths.length === snapshot.paths.length &&
			current.paths.every((path, index) => path === snapshot.paths[index])
		)
			return;
		const stored: unknown = JSON.parse(
			window.localStorage.getItem(INDEX_KEY) ?? "[]",
		);
		const recent = [
			sessionId,
			...(Array.isArray(stored) ? stored : []).filter(
				(id): id is string => typeof id === "string" && id !== sessionId,
			),
		];
		for (const evicted of recent.slice(MAX_CHATS))
			window.localStorage.removeItem(PREFIX + evicted);
		window.localStorage.setItem(
			INDEX_KEY,
			JSON.stringify(recent.slice(0, MAX_CHATS)),
		);
		window.localStorage.setItem(PREFIX + sessionId, JSON.stringify(snapshot));
	} catch {
		// Files still works; it waits for the server next time.
	}
}
