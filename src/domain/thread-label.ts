/**
 * A thread's readable name: the project's name and the thread's number,
 * "ytimesy-12". The number counts up per project in creation order and is
 * stored (agent_session.thread_number, assigned by a trigger), so a name
 * keeps meaning the same thread.
 *
 * A thread without a number (a row from before the numbers existed, read by
 * code that runs ahead of the migration) keeps the old derived label, the
 * project's first three letters and four hex digits of the chat id
 * ("YTI-6D01"). Those labels stay recognised in text, so a message written
 * with one still points at its thread.
 */

/** The longest project part of a name; a longer project name is cut at a word. */
const SLUG_LIMIT = 20;

/** "Web app" reads "web-app", "acme/Web.v2" reads "acme-web-v2"; "thread" when it has no Latin letters or digits. */
export function threadSlug(projectName: string | null | undefined) {
	const words = (projectName ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
	let slug = "";
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > SLUG_LIMIT) {
			if (!slug) slug = word.slice(0, SLUG_LIMIT);
			break;
		}
		slug = next;
	}
	return slug || "thread";
}

/** "Web app" reads "WEB", "acme/web" reads "ACM"; "THR" when it has no Latin letters. The old label's prefix. */
export function threadLabelPrefix(projectName: string | null | undefined) {
	const words = (projectName ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim();
	const prefix = (words.split(" ")[0] ?? "").slice(0, 3).toUpperCase();
	return /^[A-Z][A-Z0-9]+$/.test(prefix) ? prefix : "THR";
}

/** The old derived label from a chat id ("WEB-3F9A"); null for an id with fewer than four hex digits. */
export function legacyThreadLabel(prefix: string, chatId: string) {
	const hex = chatId
		.replace(/[^0-9a-f]/gi, "")
		.slice(0, 4)
		.toUpperCase();
	return hex.length === 4 ? `${prefix}-${hex}` : null;
}

export type ThreadRef = {
	readonly id: string;
	/** The thread's number in its project; absent or null before the numbers exist. */
	readonly threadNumber?: number | null;
};

/** The thread's name: "ytimesy-12", or its old label when it has no number. */
export function threadLabel(
	projectName: string | null | undefined,
	thread: ThreadRef,
) {
	if (thread.threadNumber != null && thread.threadNumber > 0)
		return `${threadSlug(projectName)}-${thread.threadNumber}`;
	return legacyThreadLabel(threadLabelPrefix(projectName), thread.id);
}

export type ThreadDirectory = ReadonlyMap<
	string,
	{ readonly id: string; readonly title: string }
>;

/**
 * Name → thread for the project's chats. Both forms are keyed, lowercase:
 * the numbered name and the old label, so either one in text finds the
 * thread. A clash keeps the first.
 */
export function threadDirectory(
	projectName: string | null | undefined,
	chats: readonly (ThreadRef & { readonly title: string })[],
): ThreadDirectory {
	const map = new Map<string, { id: string; title: string }>();
	const prefix = threadLabelPrefix(projectName);
	// Numbered names first, so one never loses to another thread's old label
	// that happens to read the same ("web-1234").
	for (const chat of chats) {
		if (chat.threadNumber == null || chat.threadNumber <= 0) continue;
		const key = threadLabel(projectName, chat)?.toLowerCase();
		if (key && !map.has(key)) map.set(key, { id: chat.id, title: chat.title });
	}
	for (const chat of chats) {
		const key = legacyThreadLabel(prefix, chat.id)?.toLowerCase();
		if (key && !map.has(key)) map.set(key, { id: chat.id, title: chat.title });
	}
	return map;
}

export type ThreadLabelSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "thread"; readonly label: string; readonly id: string };

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Prose split around names that belong to a known thread; anything else stays text. */
export function threadLabelSegments(
	text: string,
	directory: ThreadDirectory,
): ThreadLabelSegment[] {
	if (directory.size === 0) return text ? [{ kind: "text", text }] : [];
	// Longest first, so "ytimesy-12" wins over a shorter name it starts with.
	const names = [...directory.keys()]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	const pattern = new RegExp(
		`(?<![\\w-])(?:${names.join("|")})(?![\\w-])`,
		"gi",
	);
	const out: ThreadLabelSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		// Keys are lowercase (threadDirectory); a map built by hand may keep the old uppercase labels.
		const thread =
			directory.get(match[0].toLowerCase()) ??
			directory.get(match[0].toUpperCase());
		if (!thread) continue;
		if (match.index > last)
			out.push({ kind: "text", text: text.slice(last, match.index) });
		out.push({ kind: "thread", label: match[0], id: thread.id });
		last = match.index + match[0].length;
	}
	if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
	return out;
}
