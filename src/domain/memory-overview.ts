import {
	ALWAYS_SCOPE,
	chatIdFromSource,
	isRetired,
	MEMORY_ENTRY,
	type MemoryFiles,
	memoryLines,
	SCOPE_KEY,
	SUPERSEDED_KEY,
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
	/** Added by the user in the Memory view (`source: manual`). */
	readonly manual?: true;
	/** The chat whose statement replaced this line (`superseded-by:`). */
	readonly supersededBy?: string;
};

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
			...(entry.meta.source?.trim() === "manual"
				? { manual: true as const }
				: {}),
			...(entry.meta[SUPERSEDED_KEY]
				? {
						supersededBy:
							chatIdFromSource(entry.meta[SUPERSEDED_KEY]) ??
							entry.meta[SUPERSEDED_KEY],
					}
				: {}),
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

// ---- scopes -----------------------------------------------------------------

/** The scope of lines without `project:`: they apply in every project. */
export const PERSONAL_SCOPE = "personal";

/** A scope in the Memory view: Personal, or one project's lines. */
export type MemoryScope = {
	/** PERSONAL_SCOPE, or `project:<name lowercased>`. */
	readonly id: string;
	/** The `project:` value as first written; null for Personal. */
	readonly project: string | null;
	/** Lines in use. */
	readonly count: number;
	/** Always-on rules among them. */
	readonly rules: number;
	readonly updated?: string;
};

/** The scope a row belongs to; projects compare without case, like projectRules. */
export function rowScope(row: Pick<MemoryRow, "project">) {
	const project = row.project?.trim();
	return project ? `project:${project.toLowerCase()}` : PERSONAL_SCOPE;
}

/** MEMORY.md's `- [[topic]] …` index bullets: navigation, not memories. */
export function isIndexLink(row: Pick<MemoryRow, "path" | "text">) {
	return row.path === MEMORY_ENTRY && /^\[\[[^\]]+\]\]/.test(row.text.trim());
}

/** Rows that are memories: everything but the index's topic links. */
export function memoryEntries(rows: readonly MemoryRow[]) {
	return rows.filter((row) => !isIndexLink(row));
}

/**
 * Personal first (always present, so there is somewhere to add), then each
 * project by name. Counts leave out replaced lines.
 */
export function memoryScopes(rows: readonly MemoryRow[]): MemoryScope[] {
	const groups = new Map<string, { project: string | null; rows: MemoryRow[] }>(
		[[PERSONAL_SCOPE, { project: null, rows: [] }]],
	);
	for (const row of memoryEntries(rows)) {
		const id = rowScope(row);
		const group = groups.get(id) ?? {
			project: row.project?.trim() ?? null,
			rows: [],
		};
		groups.set(id, group);
		if (!row.replaced) group.rows.push(row);
	}
	return [...groups.entries()]
		.map(([id, group]) => ({
			id,
			project: group.project,
			count: group.rows.length,
			rules: group.rows.filter((row) => row.rule).length,
			...(newest(group.rows) ? { updated: newest(group.rows) } : {}),
		}))
		.sort(
			(a, b) =>
				Number(b.id === PERSONAL_SCOPE) - Number(a.id === PERSONAL_SCOPE) ||
				(a.project ?? "").localeCompare(b.project ?? ""),
		);
}

/** One scope's rows (all memories for null), in file order. */
export function scopeRows(
	rows: readonly MemoryRow[],
	scope: string | null,
): MemoryRow[] {
	return memoryEntries(rows).filter(
		(row) => scope === null || rowScope(row) === scope,
	);
}

/** Rows grouped by topic file: always-on rules first in each, topics by newest line. */
export function rowsByTopic(
	rows: readonly MemoryRow[],
	files: MemoryFiles,
): { path: string; title: string; rows: MemoryRow[] }[] {
	const groups = new Map<string, MemoryRow[]>();
	for (const row of rows)
		groups.set(row.path, [...(groups.get(row.path) ?? []), row]);
	return [...groups.entries()]
		.map(([path, own]) => ({
			path,
			title:
				path === MEMORY_ENTRY ? "Index" : fileTitle(path, files[path] ?? ""),
			rows: [...own].sort(
				(a, b) =>
					Number(b.rule && !b.replaced) - Number(a.rule && !a.replaced) ||
					Number(a.replaced) - Number(b.replaced) ||
					a.line - b.line,
			),
			updated: newest(own.filter((row) => !row.replaced)) ?? "",
		}))
		.sort(
			(a, b) =>
				b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title),
		)
		.map(({ path, title, rows: own }) => ({ path, title, rows: own }));
}

/** Each topic file's title, by path. */
export function topicTitles(files: MemoryFiles): Record<string, string> {
	return Object.fromEntries(
		Object.entries(files)
			.filter(([path]) => path.endsWith(".md"))
			.map(([path, content]) => [
				path,
				path === MEMORY_ENTRY ? "Index" : fileTitle(path, content),
			]),
	);
}

// ---- what a commit changed --------------------------------------------------

export type MemoryChangeSummary = {
	/** New lines that do not restate a removed one. */
	readonly added: string[];
	/** Lines folded into one line (two or more), or one line rewritten. */
	readonly merged: { readonly into: string; readonly from: string[] }[];
	/** Removed after their `expires:` date. */
	readonly expired: string[];
	/** Conflicts resolved: lines a later statement replaced, removed or marked replaced. */
	readonly resolved: string[];
	/** Removed with nothing that replaces them. */
	readonly removed: string[];
};

const isPast = (date: string | undefined, today: string) =>
	Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today);

const overlap = (a: readonly string[], b: readonly string[]) => {
	const left = new Set(a);
	const right = new Set(b);
	const shared = [...left].filter((token) => right.has(token)).length;
	return shared / Math.max(1, Math.min(left.size, right.size));
};

/**
 * What changed between two states of the repo, in the words a person reads:
 * new lines, merges (removed lines whose words a new line mostly keeps),
 * expired and replaced lines retired, and plain removals. Lines are matched
 * by their text, so a moved line is neither added nor removed.
 */
export function memoryChangeSummary(
	before: MemoryFiles,
	after: MemoryFiles,
	today: string,
	similar: (text: string) => readonly string[],
): MemoryChangeSummary {
	const key = (text: string) =>
		text.replaceAll(/\s+/g, " ").trim().toLowerCase();
	const entries = (files: MemoryFiles) =>
		memoryEntries(memoryRows(files, today));
	const old = entries(before);
	const next = entries(after);
	const nextByKey = new Map(next.map((row) => [key(row.text), row]));
	const oldKeys = new Set(old.map((row) => key(row.text)));
	const gone = old.filter((row) => !nextByKey.has(key(row.text)));
	const fresh = next.filter((row) => !oldKeys.has(key(row.text)));
	const resolved = old
		.filter((row) => {
			const later = nextByKey.get(key(row.text));
			return (
				later &&
				!row.replaced &&
				later.replaced &&
				!isPast(later.expires, today)
			);
		})
		.map((row) => row.text);
	const merged = new Map<MemoryRow, string[]>();
	const expired: string[] = [];
	const removed: string[] = [];
	const freshTokens = fresh.map((row) => similar(row.text));
	for (const row of gone) {
		if (row.replaced) {
			(isPast(row.expires, today) ? expired : resolved).push(row.text);
			continue;
		}
		const tokens = similar(row.text);
		let best = -1;
		let score = 0;
		freshTokens.forEach((candidate, index) => {
			const value = overlap(tokens, candidate);
			if (value > score) {
				score = value;
				best = index;
			}
		});
		if (best >= 0 && score >= 0.5)
			merged.set(fresh[best], [...(merged.get(fresh[best]) ?? []), row.text]);
		else removed.push(row.text);
	}
	return {
		added: fresh.filter((row) => !merged.has(row)).map((row) => row.text),
		merged: [...merged.entries()].map(([row, from]) => ({
			into: row.text,
			from,
		})),
		expired,
		resolved,
		removed,
	};
}
