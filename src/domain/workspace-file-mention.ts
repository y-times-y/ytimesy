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

/** "executor.ts:510–525": the file's name and lines, for a chip. */
export function fileReferenceLabel(reference: FileReference): string {
	const name =
		reference.path.split("/").filter(Boolean).at(-1) ?? reference.path;
	return reference.lines ? `${name}:${reference.lines}` : name;
}
