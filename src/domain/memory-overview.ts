import {
	ALWAYS_SCOPE,
	chatIdFromSource,
	isRetired,
	MEMORY_ENTRY,
	type MemoryFiles,
	memoryLines,
	SCOPE_KEY,
} from "./memory-repo";

/**
 * The Memory view's reading of the memory repo: topics (one per file) with
 * their size and last change, every entry as a row, the newest entries, and
 * a search across all of them. Pure; the view renders what this returns.
 */

/** One memory entry as a row in the Memory view. */
export type MemoryRow = {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	/** `scope: always`: a standing project rule attached to every chat. */
	readonly rule: boolean;
	/** Replaced by a later statement (`superseded-by:`) or expired: kept in the file, no longer used. */
	readonly replaced: boolean;
	readonly kind: "stated" | "inferred";
	readonly project?: string;
	readonly expires?: string;
	/** `added:` date (YYYY-MM-DD). */
	readonly added?: string;
	/** The chat the entry came from. */
	readonly chatId?: string;
};

/** A topic in the Memory view's list: a memory file, or the pinned project rules. */
export type MemoryTopic = {
	/** A file path, or RULES_TOPIC for the project rules across files. */
	readonly id: string;
	readonly title: string;
	/** Entries in use (replaced ones not counted). */
	readonly count: number;
	/** The newest `added:` date among its entries. */
	readonly updated?: string;
};

export const RULES_TOPIC = "rules:always";
const RULES_TITLE = "Project rules";

export function memoryRows(files: MemoryFiles, today: string): MemoryRow[] {
	return memoryLines(files).map((entry) => {
		const chatId = entry.meta.source
			? chatIdFromSource(entry.meta.source)
			: null;
		return {
			path: entry.path,
			line: entry.line,
			text: entry.text,
			rule: entry.meta[SCOPE_KEY]?.toLowerCase() === ALWAYS_SCOPE,
			replaced: isRetired(entry.meta, today),
			kind: entry.meta.kind === "inferred" ? "inferred" : "stated",
			...(entry.meta.project ? { project: entry.meta.project } : {}),
			...(entry.meta.expires ? { expires: entry.meta.expires } : {}),
			...(/^\d{4}-\d{2}-\d{2}$/.test(entry.meta.added ?? "")
				? { added: entry.meta.added }
				: {}),
			...(chatId ? { chatId } : {}),
		};
	});
}

const newest = (rows: readonly MemoryRow[]) =>
	rows.reduce<string | undefined>(
		(latest, row) =>
			row.added && (!latest || row.added > latest) ? row.added : latest,
		undefined,
	);

/** A file's title: its first heading, else its name without .md. */
function fileTitle(path: string, content: string) {
	const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
	return heading || path.replace(/\.md$/, "");
}

/**
 * The topic list: the project rules first (when any), then each topic file by
 * its newest entry, and the MEMORY.md index last.
 */
export function memoryTopics(files: MemoryFiles, today: string): MemoryTopic[] {
	const rows = memoryRows(files, today);
	const live = rows.filter((row) => !row.replaced);
	const rules = live.filter((row) => row.rule);
	const topics = Object.entries(files)
		.filter(([path]) => path.endsWith(".md") && path !== MEMORY_ENTRY)
		.map(([path, content]) => {
			const own = live.filter((row) => row.path === path);
			return {
				id: path,
				// A file titled like the pinned rules topic goes by its file name.
				title:
					rules.length &&
					fileTitle(path, content).toLowerCase() === RULES_TITLE.toLowerCase()
						? path.replace(/\.md$/, "")
						: fileTitle(path, content),
				count: own.length,
				...(newest(own) ? { updated: newest(own) } : {}),
			};
		})
		.sort(
			(a, b) =>
				(b.updated ?? "").localeCompare(a.updated ?? "") ||
				a.title.localeCompare(b.title),
		);
	return [
		...(rules.length
			? [
					{
						id: RULES_TOPIC,
						title: RULES_TITLE,
						count: rules.length,
						...(newest(rules) ? { updated: newest(rules) } : {}),
					},
				]
			: []),
		...topics,
		...(files[MEMORY_ENTRY] !== undefined
			? [
					{
						id: MEMORY_ENTRY,
						title: "Index",
						count: live.filter((row) => row.path === MEMORY_ENTRY).length,
					},
				]
			: []),
	];
}

/** A topic's rows: the rules across files, or one file's entries in file order. */
export function topicRows(
	rows: readonly MemoryRow[],
	topic: string,
): MemoryRow[] {
	return topic === RULES_TOPIC
		? rows.filter((row) => row.rule && !row.replaced)
		: rows.filter((row) => row.path === topic);
}

/** The newest dated entries in use, newest first. */
export function recentMemoryRows(
	rows: readonly MemoryRow[],
	limit = 12,
): MemoryRow[] {
	return rows
		.filter((row) => row.added && !row.replaced)
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) =>
				(b.row.added ?? "").localeCompare(a.row.added ?? "") ||
				b.index - a.index,
		)
		.slice(0, limit)
		.map(({ row }) => row);
}

/** Rows whose text, topic or project contains every word of the query. */
export function searchMemoryRows(
	rows: readonly MemoryRow[],
	query: string,
): MemoryRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return rows.filter((row) => {
		const haystack =
			`${row.text} ${row.path} ${row.project ?? ""}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
