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
	return files.filter((file) => file.path !== null || file.lines.length);
}
