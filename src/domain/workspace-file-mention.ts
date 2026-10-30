/** A line or line range after a path: ":12", ":12-34", ":12–34", ":12:5", "#L12-L34". */
const LINES = /(?::(\d+)(?:[-–—](\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;

/** A workspace file a chat names, and the lines it points at, if any. */
export type FileReference = {
	readonly path: string;
	readonly lines: string | null;
};

export function workspaceFileReference(value: string): FileReference | null {
	const text = value.trim();
	if (!text || /\s/.test(text) || text.includes("*") || text.startsWith("//"))
		return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("#")) return null;
	const match = LINES.exec(text);
	const path = match ? text.slice(0, match.index) : text;
	if (!path || !(path.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(path)))
		return null;
	const start = match?.[1] ?? match?.[3];
	const end = match?.[2] ?? match?.[4];
	return {
		path,
		lines: start ? (end && end !== start ? `${start}–${end}` : start) : null,
	};
}

/** The file's path, without any line range, or null when it is not a file. */
export function workspaceFileMention(value: string): string | null {
	return workspaceFileReference(value)?.path ?? null;
}

function fileName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * "executor.ts:510–525": the file's name and lines, for a chip. A name that
 * two different paths share (`shared`) keeps its folder: "services/archive.ts".
 */
export function fileReferenceLabel(
	reference: FileReference,
	shared: ReadonlySet<string> = new Set(),
): string {
	const parts = reference.path.split("/").filter(Boolean);
	const name = fileName(reference.path);
	const label =
		shared.has(name) && parts.length > 1 ? parts.slice(-2).join("/") : name;
	return reference.lines ? `${label}:${reference.lines}` : label;
}

/** File names that more than one path in this markdown ends with. */
export function sharedFileNames(markdown: string): Set<string> {
	const paths = new Map<string, Set<string>>();
	const candidates = [
		...markdown.matchAll(/`([^`\n]+)`/g),
		...markdown.matchAll(/\]\(([^)\s]+)\)/g),
	];
	for (const [, value] of candidates) {
		const reference = workspaceFileReference(value ?? "");
		if (!reference) continue;
		const name = fileName(reference.path);
		const seen = paths.get(name) ?? new Set();
		seen.add(reference.path.replace(/^\.?\//, ""));
		paths.set(name, seen);
	}
	return new Set(
		[...paths].filter(([, seen]) => seen.size > 1).map(([name]) => name),
	);
}
