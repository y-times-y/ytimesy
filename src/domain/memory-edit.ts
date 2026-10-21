import {
	ALWAYS_SCOPE,
	appendMemoryEntry,
	MEMORY_ENTRY,
	type MemoryChange,
	type MemoryFiles,
	type MemoryLine,
	memoryBullet,
	memoryPath,
	parseMemoryLine,
	SCOPE_KEY,
} from "./memory-repo";

/**
 * Edits the user makes by hand in the Memory view: add a line, change its
 * text, move it between Personal (no `project:`) and a project, pin it as an
 * always-on rule (`scope: always`), or delete it. Each edit is a pure change
 * to one or two files; the server commits it as one memory commit. Lines
 * stay in the Agent Memory Repo format: `- <text> [key: value; …]`.
 */

/** Where a manually added line says it came from. */
export const MANUAL_SOURCE = "manual";
/** Topic file a new line goes to when none is chosen. */
export const DEFAULT_TOPIC = "notes.md";
export const MEMORY_EDIT_TEXT_MAX = 500;
export const MEMORY_PROJECT_MAX = 200;

/** A line as the view saw it: its file, 1-based line number and text. */
export type MemoryLineRef = {
	readonly path: string;
	readonly line: number;
	readonly text: string;
};

const normalized = (text: string) =>
	text.replaceAll(/\s+/g, " ").trim().toLowerCase();

/**
 * Text typed by the user as one entry's text: one line, no bullet marker,
 * and nothing a parser would read back as metadata. Null when it cannot be
 * stored as typed (empty, too long, or ending in `[key: value]`).
 */
export function memoryEntryText(input: string): string | null {
	const text = input
		.replaceAll(/\s+/g, " ")
		.trim()
		.replace(/^[-*]\s+/, "")
		.trim();
	if (!text || text.length > MEMORY_EDIT_TEXT_MAX) return null;
	const parsed = parseMemoryLine(memoryBullet(text, { source: MANUAL_SOURCE }));
	return parsed?.text === text && Object.keys(parsed.meta).length === 1
		? text
		: null;
}

/** A project name as `project:` metadata holds it; null when it cannot. */
export function memoryProjectValue(input: string): string | null {
	const value = input.trim();
	if (!value || value.length > MEMORY_PROJECT_MAX || /[;[\]\n\r]/.test(value))
		return null;
	return value;
}

/** A topic file new lines may go to: a Markdown path in the repo, not the index. */
export function memoryTopicPath(input: string): string | null {
	const path = memoryPath(input);
	if (!path || path === MEMORY_ENTRY) return null;
	return path.endsWith(".md") ? path : null;
}

/**
 * The line `ref` names: at its line number when that line still has its
 * text, else the one line in the file with that text. Null when memory no
 * longer holds it, or holds it more than once elsewhere (ambiguous).
 */
export function findMemoryLine(
	files: MemoryFiles,
	ref: MemoryLineRef,
): MemoryLine | null {
	const content = files[ref.path];
	if (content === undefined) return null;
	const lines = content.split("\n");
	const key = normalized(ref.text);
	const at = (index: number) =>
		parseMemoryLine(lines[index] ?? "", ref.path, index + 1);
	const exact = at(ref.line - 1);
	if (exact && normalized(exact.text) === key) return exact;
	const matches = lines.flatMap((_, index) => {
		const entry = at(index);
		return entry && normalized(entry.text) === key ? [entry] : [];
	});
	return matches.length === 1 ? matches[0] : null;
}

function replaceLine(
	files: MemoryFiles,
	entry: MemoryLine,
	next: string | null,
): MemoryChange {
	const lines = (files[entry.path] ?? "").split("\n");
	if (next === null) lines.splice(entry.line - 1, 1);
	else lines[entry.line - 1] = next;
	return { path: entry.path, content: lines.join("\n") };
}

function scopeLabel(project: string | null) {
	return project ? `project ${project}` : "Personal";
}

function clipped(text: string) {
	return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

export type MemoryEditResult =
	| { ok: true; changes: MemoryChange[]; message: string }
	| { ok: false; error: string };

/** A new line in plain words, stated by the user, dated today. */
export function addMemoryLine(
	files: MemoryFiles,
	input: {
		text: string;
		project: string | null;
		always: boolean;
		topic?: string | null;
		today: string;
	},
): MemoryEditResult {
	const text = memoryEntryText(input.text);
	if (!text) return { ok: false, error: invalidText(input.text) };
	const project =
		input.project === null ? null : memoryProjectValue(input.project);
	if (input.project !== null && !project)
		return { ok: false, error: "That project name cannot be stored." };
	const topic = memoryTopicPath(input.topic || DEFAULT_TOPIC);
	if (!topic) return { ok: false, error: "That topic cannot be used." };
	const bullet = memoryBullet(text, {
		...(input.always ? { [SCOPE_KEY]: ALWAYS_SCOPE } : {}),
		...(project ? { project } : {}),
		source: MANUAL_SOURCE,
		added: input.today,
	});
	return {
		ok: true,
		changes: appendMemoryEntry(files, topic, bullet),
		message: `${input.always ? "Add always-on rule" : "Add memory"} (${scopeLabel(project)}): ${clipped(text)}`,
	};
}

function invalidText(input: string) {
	const trimmed = input.trim();
	if (!trimmed) return "Write what should be remembered.";
	if (trimmed.length > MEMORY_EDIT_TEXT_MAX)
		return `Keep it under ${MEMORY_EDIT_TEXT_MAX} characters.`;
	return "That text ends like line metadata; reword the end.";
}

/**
 * Changes one line in place: its text, its scope (`project:`, null for
 * Personal), and whether it is an always-on rule. Other metadata is kept.
 * Only the given fields change; nothing to change is an error.
 */
export function updateMemoryLine(
	files: MemoryFiles,
	ref: MemoryLineRef,
	update: {
		text?: string;
		/** null moves the line to Personal. */
		project?: string | null;
		always?: boolean;
	},
): MemoryEditResult {
	const entry = findMemoryLine(files, ref);
	if (!entry) return { ok: false, error: "Memory no longer has that line." };
	const meta: Record<string, string> = { ...entry.meta };
	const notes: string[] = [];
	let text = entry.text;
	if (update.text !== undefined) {
		const next = memoryEntryText(update.text);
		if (!next) return { ok: false, error: invalidText(update.text) };
		if (next !== entry.text) {
			text = next;
			notes.push("Edit memory");
		}
	}
	if (update.project !== undefined) {
		const project =
			update.project === null ? null : memoryProjectValue(update.project);
		if (update.project !== null && !project)
			return { ok: false, error: "That project name cannot be stored." };
		const current = meta.project?.trim() || null;
		if ((current ?? "").toLowerCase() !== (project ?? "").toLowerCase()) {
			if (project) meta.project = project;
			else delete meta.project;
			notes.push(`Move memory to ${scopeLabel(project)}`);
		}
	}
	if (update.always !== undefined) {
		const pinned = meta[SCOPE_KEY]?.toLowerCase() === ALWAYS_SCOPE;
		if (update.always !== pinned) {
			if (update.always) meta[SCOPE_KEY] = ALWAYS_SCOPE;
			else delete meta[SCOPE_KEY];
			notes.push(
				update.always ? "Pin as always-on rule" : "Unpin always-on rule",
			);
		}
	}
	if (!notes.length) return { ok: false, error: "Nothing changed." };
	return {
		ok: true,
		changes: [replaceLine(files, entry, memoryBullet(text, meta))],
		message: `${notes.join("; ")}: ${clipped(text)}`,
	};
}

/** Removes one line; the file and its index link stay. */
export function deleteMemoryLine(
	files: MemoryFiles,
	ref: MemoryLineRef,
): MemoryEditResult {
	const entry = findMemoryLine(files, ref);
	if (!entry) return { ok: false, error: "Memory no longer has that line." };
	return {
		ok: true,
		changes: [replaceLine(files, entry, null)],
		message: `Delete memory: ${clipped(entry.text)}`,
	};
}

export type MemoryEdit =
	| {
			op: "add";
			text: string;
			project: string | null;
			always: boolean;
			topic?: string | null;
	  }
	| {
			op: "update";
			ref: MemoryLineRef;
			text?: string;
			project?: string | null;
			always?: boolean;
	  }
	| { op: "delete"; ref: MemoryLineRef };

/** One edit against the files as they are now. */
export function applyMemoryEdit(
	files: MemoryFiles,
	edit: MemoryEdit,
	today: string,
): MemoryEditResult {
	switch (edit.op) {
		case "add":
			return addMemoryLine(files, { ...edit, today });
		case "update":
			return updateMemoryLine(files, edit.ref, edit);
		case "delete":
			return deleteMemoryLine(files, edit.ref);
	}
}
