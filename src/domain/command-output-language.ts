import { type SourceLanguage, sourceLanguageFromPath } from "./source-language";
import { unwrapShellCommand } from "./visible-shell-command";

/** Commands that print a file as it is (or a slice of it). */
const PRINTERS = new Set(["cat", "head", "tail", "sed", "nl", "bat"]);
/** Commands that only slice what is piped into them. */
const SLICERS = /^(?:head|tail|nl|sed\s+-n)\b/;

/**
 * The language a command's output is written in, when it is plainly one
 * file (`cat src/a.ts`, `sed -n '1,80p' app.py`) or a diff (`git diff`), so
 * the output can be coloured like the file. Anything else is "text".
 */
export function commandOutputLanguage(command: string): SourceLanguage {
	const text = unwrapShellCommand(command);
	if (/[;&\n<>`$]/.test(text)) return "text";
	const [first = "", ...rest] = text.split("|").map((part) => part.trim());
	if (!rest.every((part) => SLICERS.test(part))) return "text";
	if (/^git\s+(?:diff|show)\b/.test(first))
		return /\s--(?:stat|name-only|name-status|shortstat|numstat)\b/.test(first)
			? "text"
			: "diff";
	const words = first.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
	const [program = "", ...args] = words;
	if (!PRINTERS.has(program)) return "text";
	const files = args.filter(
		(arg, index) =>
			!arg.startsWith("-") &&
			!/^['"]/.test(arg) &&
			!/^\d+$/.test(arg) &&
			// `head -n 20 file`: 20 belongs to -n.
			!/^-[nc]$/.test(args[index - 1] ?? ""),
	);
	return files.length === 1
		? sourceLanguageFromPath(files[0] as string)
		: "text";
}

export type DiffOutputLine = {
	/**
	 * "break" stands between two hunks; "other" is text outside any hunk
	 * (git show's commit header). Git's own headers (diff --git, index,
	 * ---/+++, @@) are not lines: the file's path and counts replace them.
	 */
	readonly kind: "added" | "removed" | "context" | "break" | "other";
	/** The line without its +, - or space marker. */
	readonly code: string;
	/** Its line in the new file (the old file for removed lines). */
	readonly number?: number;
	/** [start, end) of the words that changed, against its paired line. */
	readonly changed?: readonly [number, number];
};

export type DiffOutputFile = {
	/** Null for text before the first file (git show's commit header). */
	path: string | null;
	language: SourceLanguage;
	added: number;
	removed: number;
	lines: DiffOutputLine[];
};

const GIT_HEADER =
	/^(?:diff --git |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary )/;

/**
 * Diff output split per file the way Codex draws it: each file's path,
 * language and +/- counts, then its lines numbered, with hunks separated by
 * a break instead of git's @@ headers.
 */
export function diffOutputFiles(output: string): DiffOutputFile[] {
	const files: DiffOutputFile[] = [];
	const lines = output.replace(/\n+$/, "").split("\n");
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const text of lines) {
		const startsFile = text.startsWith("diff --git ");
		if (!files.length || startsFile) {
			files.push({
				path: startsFile ? (text.match(/ b\/(.+)$/)?.[1] ?? null) : null,
				language: "text",
				added: 0,
				removed: 0,
				lines: [],
			});
			inHunk = false;
		}
		const file = files[files.length - 1] as DiffOutputFile;
		const path = text.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/)?.[1];
		if (path && path !== "/dev/null") {
			file.path = path;
			file.language = sourceLanguageFromPath(path);
		}
		const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
		if (hunk) {
			if (file.lines.some((line) => line.number !== undefined))
				file.lines.push({ kind: "break", code: "" });
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (file.path !== null && GIT_HEADER.test(text)) {
			inHunk = false;
			continue;
		}
		if (!inHunk || (!/^[+\- ]/.test(text) && text !== "")) {
			file.lines.push({ kind: "other", code: text });
			continue;
		}
		const kind = text.startsWith("+")
			? "added"
			: text.startsWith("-")
				? "removed"
				: "context";
		const number = kind === "removed" ? oldLine : newLine;
		if (kind !== "added") oldLine++;
		if (kind !== "removed") newLine++;
		if (kind === "added") file.added++;
		if (kind === "removed") file.removed++;
		file.lines.push({ kind, code: text.slice(1), number });
	}
	for (const file of files) markChangedWords(file.lines);
	return files.filter((file) => file.path !== null || file.lines.length);
}

/**
 * Pairs each run of removed lines with the run of added lines right after
 * it, line by line, and marks the words that differ, so an edit inside a
 * line stands out from the lines around it. Lines that differ almost
 * everywhere stay unmarked (changedWords returns null).
 */
function markChangedWords(lines: DiffOutputLine[]) {
	for (let start = 0; start < lines.length; ) {
		let removedEnd = start;
		while (lines[removedEnd]?.kind === "removed") removedEnd++;
		let addedEnd = removedEnd;
		while (lines[addedEnd]?.kind === "added") addedEnd++;
		const pairs = Math.min(removedEnd - start, addedEnd - removedEnd);
		for (let index = 0; index < pairs; index++) {
			const removed = lines[start + index] as DiffOutputLine;
			const added = lines[removedEnd + index] as DiffOutputLine;
			const ranges = changedWords(removed.code, added.code);
			if (!ranges) continue;
			lines[start + index] = { ...removed, changed: ranges[0] };
			lines[removedEnd + index] = { ...added, changed: ranges[1] };
		}
		start = Math.max(addedEnd, start + 1);
	}
}

const WORD = /\w/;

/**
 * The differing middle of two lines (after their common start and end),
 * widened to whole words. Null when the lines match or differ almost
 * everywhere: a rewritten line needs no word marks.
 */
export function changedWords(
	before: string,
	after: string,
): readonly [readonly [number, number], readonly [number, number]] | null {
	if (before === after) return null;
	let prefix = 0;
	while (
		prefix < before.length &&
		prefix < after.length &&
		before[prefix] === after[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	const widen = (text: string, from: number, to: number) => {
		let start = from;
		let end = to;
		while (
			start > 0 &&
			WORD.test(text[start - 1] ?? "") &&
			WORD.test(text[start] ?? text[start - 1] ?? "")
		)
			start--;
		while (
			end < text.length &&
			end > 0 &&
			WORD.test(text[end] ?? "") &&
			WORD.test(text[end - 1] ?? "")
		)
			end++;
		return [start, end] as const;
	};
	const old = widen(before, prefix, before.length - suffix);
	const next = widen(after, prefix, after.length - suffix);
	const content = (text: string) => text.trim().length || 1;
	if (
		(old[1] - old[0]) / content(before) > 0.6 ||
		(next[1] - next[0]) / content(after) > 0.6
	)
		return null;
	return [old, next];
}

/**
 * An edit's hunks (old text replaced by new) as diff lines: each hunk's
 * removed lines, then its added ones, with the changed words marked and a
 * break between hunks. Edits carry no line numbers.
 */
export function editDiffLines(
	hunks: readonly { readonly removed: string; readonly added: string }[],
): DiffOutputLine[] {
	const lines: DiffOutputLine[] = [];
	const split = (text: string) =>
		text ? text.replace(/\n$/, "").split("\n") : [];
	hunks.forEach((hunk, index) => {
		if (index) lines.push({ kind: "break", code: "" });
		for (const code of split(hunk.removed))
			lines.push({ kind: "removed", code });
		for (const code of split(hunk.added)) lines.push({ kind: "added", code });
	});
	markChangedWords(lines);
	return lines;
}

/**
 * A patch as files of diff lines. apply_patch's own format (`*** Update
 * File: path`, `@@`, then +, - and space lines) carries paths but no line
 * numbers; a unified diff goes through diffOutputFiles.
 */
export function patchDiffFiles(patch: string): DiffOutputFile[] {
	if (!/^\*\*\* (?:Begin Patch|Update File|Add File|Delete File)/m.test(patch))
		return diffOutputFiles(patch);
	const files: DiffOutputFile[] = [];
	for (const text of patch.replace(/\n+$/, "").split("\n")) {
		const header = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
		if (header) {
			const path = (header[1] as string).trim();
			files.push({
				path,
				language: sourceLanguageFromPath(path),
				added: 0,
				removed: 0,
				lines: [],
			});
			continue;
		}
		const file = files[files.length - 1];
		if (!file || text.startsWith("***")) continue;
		if (text.startsWith("@@")) {
			if (file.lines.length) file.lines.push({ kind: "break", code: "" });
			continue;
		}
		const kind = text.startsWith("+")
			? "added"
			: text.startsWith("-")
				? "removed"
				: "context";
		if (kind === "added") file.added++;
		if (kind === "removed") file.removed++;
		file.lines.push({
			kind,
			code: /^[+\- ]/.test(text) ? text.slice(1) : text,
		});
	}
	for (const file of files) markChangedWords(file.lines);
	return files;
}
