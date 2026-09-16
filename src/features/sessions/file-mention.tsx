import type { FileChangeEntry } from "#/domain/session-item";
import { fileChangeForPath } from "#/domain/workspace-file-tree";

export function FileMentionButton({
	path,
	name,
	change,
	onOpenFile,
}: {
	path: string;
	name: string;
	change?: FileChangeEntry["change"];
	onOpenFile?: (path: string) => void;
}) {
	const color = (
		<span className="session-file-name" data-change={change}>
			{name}
		</span>
	);
	if (!onOpenFile) return color;
	return (
		<button
			type="button"
			className="session-file-open"
			title={`Open ${path}`}
			onClick={() => onOpenFile(path)}
		>
			{color}
		</button>
	);
}

export function mentionedFileChange(
	path: string,
	changes: readonly FileChangeEntry[],
) {
	return fileChangeForPath(changes, path);
}
