import {
	isMemoryProjectKey,
	memoryPathScope,
	memoryProjectKeys,
	PERSONAL_FOLDER,
	projectFolderPath,
	projectKeyId,
	projectKeySlug,
	projectSlug,
	topicFileName,
} from "./memory-layout";
import { memoryTokens } from "./memory-ranking";
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
 * text, move it between personal/ and a project's folder (projects/<key>/),
 * pin it as an always-on rule (`scope: always`), or delete it. Each edit is
 * a pure change to a few files; the server commits it as one memory commit.
 * Lines stay in the Agent Memory Repo format: `- <text> [key: value; …]`.
 * A "project" here is a project folder key (memory-layout.ts).
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

/**
 * A project folder key as the view sends it; an owner/name (older clients)
 * becomes its slug. Null when it cannot name a folder.
 */
export function memoryProjectValue(input: string): string | null {
	const value = input.trim();
	if (!value || value.length > MEMORY_PROJECT_MAX || /[;[\]\n\r]/.test(value))
		return null;
	return isMemoryProjectKey(value) ? value : projectSlug(value);
}

/**
 * The folder key a project value resolves to in these files: the existing
 * folder with its repository id (a renamed repo keeps its folder), else the
 * one with its slug, else the value itself (a new folder).
 */
export function resolveProjectKey(files: MemoryFiles, key: string) {
	const keys = memoryProjectKeys(files);
	if (keys.includes(key)) return key;
	const id = projectKeyId(key);
	return (
		(id !== null
			? keys.find((other) => projectKeyId(other) === id)
			: keys.find((other) => projectKeySlug(other) === key)) ?? key
	);
}

/** `personal`, or `projects/<key>` for a project. */
function folderFor(files: MemoryFiles, project: string | null) {
	return project
		? projectFolderPath(resolveProjectKey(files, project))
		: PERSONAL_FOLDER;
}

/** The project a line applies to: its folder's key, or a legacy `project:` value. */
function lineProjectOf(entry: MemoryLine) {
	const scope = memoryPathScope(entry.path);
	if (scope.kind === "project") return scope.key;
	if (scope.kind === "personal") return null;
	return entry.meta.project?.trim() || null;
}

/** A topic file new lines may go to: a Markdown path in the repo, not the index. */
export function memoryTopicPath(input: string): string | null {
	const path = memoryPath(input);
	if (!path || path === MEMORY_ENTRY) return null;
	return path.endsWith(".md") ? path : null;
}

/** A topic in `folder`: a chosen file's name (whatever folder it was in) under that folder. */
function topicIn(folder: string, topic: string) {
	return `${folder}/${topicFileName(topic)}`;
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
	return project ? `project ${projectKeySlug(project)}` : "Personal";
}

function clipped(text: string) {
	return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

export type MemoryEditResult =
	| {
			ok: true;
			changes: MemoryChange[];
			message: string;
			/** The new line, for an add (so the view can show and undo it). */
			added?: MemoryLineRef;
	  }
	| { ok: false; error: string };

/**
 * The topic file a new line fits best: the one sharing the most words with
 * the text, by its title (counted double) and its lines; ties go to the
 * larger topic. Deterministic and model-free. DEFAULT_TOPIC when nothing
 * shares a word.
 */
export function suggestMemoryTopic(
	files: MemoryFiles,
	text: string,
	/** Only topics in this folder (`personal`, `projects/<key>`); the answer is still a path. */
	folder?: string,
): string {
	const fallback = folder ? `${folder}/${DEFAULT_TOPIC}` : DEFAULT_TOPIC;
	const words = new Set(memoryTokens(text));
	if (!words.size) return fallback;
	let best: { path: string; score: number; size: number } | null = null;
	for (const [path, content] of Object.entries(files)) {
		if (!path.endsWith(".md") || path === MEMORY_ENTRY) continue;
		if (folder && !path.startsWith(`${folder}/`)) continue;
		const title = /^#\s+(.+)$/m.exec(content)?.[1] ?? path.replace(/\.md$/, "");
		const titleWords = new Set(
			memoryTokens(
				`${title} ${path.replace(/\.md$/, "").replaceAll(/[-_/]/g, " ")}`,
			),
		);
		const lines = content.split("\n").flatMap((raw) => {
			const entry = parseMemoryLine(raw);
			return entry ? [new Set(memoryTokens(entry.text))] : [];
		});
		let score = 0;
		for (const word of words) {
			if (titleWords.has(word)) score += 2;
			score += Math.min(2, lines.filter((line) => line.has(word)).length) * 0.5;
		}
		if (
			score > 0 &&
			(!best ||
				score > best.score ||
				(score === best.score && lines.length > best.size))
		)
			best = { path, score, size: lines.length };
	}
	return best ? best.path : fallback;
}

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
	const folder = folderFor(files, project);
	const chosen = input.topic
		? memoryTopicPath(input.topic)
		: suggestMemoryTopic(files, text, folder);
	if (!chosen) return { ok: false, error: "That topic cannot be used." };
	const topic = memoryTopicPath(topicIn(folder, chosen));
	if (!topic) return { ok: false, error: "That topic cannot be used." };
	const bullet = memoryBullet(text, {
		...(input.always ? { [SCOPE_KEY]: ALWAYS_SCOPE } : {}),
		source: MANUAL_SOURCE,
		added: input.today,
	});
	const changes = appendMemoryEntry(files, topic, bullet);
	const written =
		changes.find((change) => change.path === topic)?.content ?? "";
	return {
		ok: true,
		changes,
		added: { path: topic, line: written.trimEnd().split("\n").length, text },
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
 * Changes one line: its text and whether it is an always-on rule in place,
 * and its scope (a project folder key, null for Personal) by moving it to
 * the same topic in that folder. Other metadata is kept (a legacy
 * `project:` key goes, since the folder says it now). Only the given fields
 * change; nothing to change is an error.
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
	let target: string | null = null;
	if (update.project !== undefined) {
		const project =
			update.project === null ? null : memoryProjectValue(update.project);
		if (update.project !== null && !project)
			return { ok: false, error: "That project name cannot be stored." };
		const current = lineProjectOf(entry);
		const wanted = project ? resolveProjectKey(files, project) : null;
		const same =
			current === null
				? wanted === null
				: wanted !== null &&
					(current.toLowerCase() === wanted.toLowerCase() ||
						(memoryPathScope(entry.path).kind === "legacy" &&
							projectSlug(current) === projectKeySlug(wanted)));
		if (!same) {
			delete meta.project;
			target = topicIn(folderFor(files, wanted), entry.path);
			notes.push(`Move memory to ${scopeLabel(wanted)}`);
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
	const bullet = memoryBullet(text, meta);
	const message = `${notes.join("; ")}: ${clipped(text)}`;
	if (!target || target === entry.path)
		return { ok: true, changes: [replaceLine(files, entry, bullet)], message };
	// A move: out of its file, onto the end of the same topic in the target folder.
	const removed = replaceLine(files, entry, null);
	const after = { ...files, [removed.path]: removed.content ?? "" };
	return {
		ok: true,
		changes: [removed, ...appendMemoryEntry(after, target, bullet)],
		message,
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
