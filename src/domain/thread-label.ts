/**
 * A short, stable label per thread ("WEB-3F9A"): the project's prefix and
 * the first four hex digits of the chat id. Derived, never stored, so it
 * needs no migration and cannot drift; a stored per-project sequence
 * (WEB-41) would be an additive column with a lazy backfill, and every
 * reader goes through this module, so only it would change.
 */

const LABEL_IN_TEXT = /(?<![\w-])([A-Z][A-Z0-9]{1,4})-([0-9A-F]{4})(?![\w-])/g;

/** "Web app" reads "WEB", "acme/web" reads "ACM"; "THR" when it has no Latin letters. */
export function threadLabelPrefix(projectName: string | null | undefined) {
	const words = (projectName ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim();
	const prefix = (words.split(" ")[0] ?? "").slice(0, 3).toUpperCase();
	return /^[A-Z][A-Z0-9]+$/.test(prefix) ? prefix : "THR";
}

/** The thread's label from its chat id; null for an id with fewer than four hex digits. */
export function threadLabel(prefix: string, chatId: string) {
	const hex = chatId
		.replace(/[^0-9a-f]/gi, "")
		.slice(0, 4)
		.toUpperCase();
	return hex.length === 4 ? `${prefix}-${hex}` : null;
}

export type ThreadDirectory = ReadonlyMap<
	string,
	{ readonly id: string; readonly title: string }
>;

/** Label → thread for the project's chats (a clash keeps the first). */
export function threadDirectory(
	prefix: string,
	chats: readonly { readonly id: string; readonly title: string }[],
): ThreadDirectory {
	const map = new Map<string, { id: string; title: string }>();
	for (const chat of chats) {
		const label = threadLabel(prefix, chat.id);
		if (label && !map.has(label))
			map.set(label, { id: chat.id, title: chat.title });
	}
	return map;
}

export type ThreadLabelSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "thread"; readonly label: string; readonly id: string };

/** Prose split around labels that name a known thread; unknown labels stay text. */
export function threadLabelSegments(
	text: string,
	directory: ThreadDirectory,
): ThreadLabelSegment[] {
	const out: ThreadLabelSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(LABEL_IN_TEXT)) {
		const label = `${match[1]}-${match[2]}`;
		const thread = directory.get(label);
		if (!thread) continue;
		if (match.index > last)
			out.push({ kind: "text", text: text.slice(last, match.index) });
		out.push({ kind: "thread", label, id: thread.id });
		last = match.index + match[0].length;
	}
	if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
	return out;
}
