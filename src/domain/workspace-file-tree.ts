import { fileBasename } from "./file-kind";
import type { FileChangeEntry } from "./session-item";
import { visibleWorkspacePath } from "./visible-workspace-path";

export type WorkspaceFileNode = {
	readonly kind: "file";
	readonly name: string;
	readonly path: string;
	readonly change: FileChangeEntry;
};

export type WorkspaceDirNode = {
	readonly kind: "dir";
	readonly name: string;
	readonly path: string;
	readonly children: readonly WorkspaceTreeNode[];
};

export type WorkspaceTreeNode = WorkspaceFileNode | WorkspaceDirNode;

type DraftDir = {
	readonly dirs: Map<string, DraftDir>;
	readonly files: Map<string, FileChangeEntry>;
};

export function workspaceFileTree(
	changes: readonly FileChangeEntry[],
): readonly WorkspaceTreeNode[] {
	const root = emptyDraft();
	for (const change of changes) {
		const path = visibleWorkspacePath(change.path);
		const parts = path.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		insertChange(root, parts, change);
	}
	return finalizeDraft(root, "");
}

export function fileChangeForPath(
	changes: readonly FileChangeEntry[],
	requested: string,
): FileChangeEntry | undefined {
	const want = visibleWorkspacePath(requested);
	const exact = changes.find(
		(change) =>
			change.path === requested || visibleWorkspacePath(change.path) === want,
	);
	if (exact) return exact;
	const base = fileBasename(want);
	const matches = changes.filter(
		(change) => fileBasename(visibleWorkspacePath(change.path)) === base,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function firstWorkspaceFilePath(
	nodes: readonly WorkspaceTreeNode[],
): string | undefined {
	for (const node of nodes) {
		if (node.kind === "file") return node.path;
		const nested = firstWorkspaceFilePath(node.children);
		if (nested) return nested;
	}
	return undefined;
}

function emptyDraft(): DraftDir {
	return { dirs: new Map(), files: new Map() };
}

function insertChange(
	draft: DraftDir,
	parts: readonly string[],
	change: FileChangeEntry,
): void {
	const [head, ...rest] = parts;
	if (!head) return;
	if (rest.length === 0) {
		draft.files.set(head, change);
		return;
	}
	const existing = draft.dirs.get(head);
	const next = existing ?? emptyDraft();
	if (!existing) draft.dirs.set(head, next);
	insertChange(next, rest, change);
}

function finalizeDraft(
	draft: DraftDir,
	path: string,
): readonly WorkspaceTreeNode[] {
	const dirs = [...draft.dirs.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, child]) => {
			const childPath = path ? `${path}/${name}` : name;
			return {
				kind: "dir" as const,
				name,
				path: childPath,
				children: finalizeDraft(child, childPath),
			};
		});
	const files = [...draft.files.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, change]) => ({
			kind: "file" as const,
			name,
			path: visibleWorkspacePath(change.path),
			change,
		}));
	return [...dirs, ...files];
}
