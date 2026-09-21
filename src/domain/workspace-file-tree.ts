import { fileBasename } from "./file-kind";
import type { FileChangeEntry } from "./session-item";
import { visibleWorkspacePath } from "./visible-workspace-path";

export type WorkspaceFileNode = {
	readonly kind: "file";
	readonly name: string;
	readonly path: string;
	readonly change?: FileChangeEntry;
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
	readonly files: Map<string, FileChangeEntry | undefined>;
};

export function workspaceFileTree(
	changes: readonly FileChangeEntry[],
): readonly WorkspaceTreeNode[] {
	return workspaceExplorerTree(
		changes.map((change) => change.path),
		changes,
	);
}

export function workspaceExplorerTree(
	paths: readonly string[],
	changes: readonly FileChangeEntry[] = [],
): readonly WorkspaceTreeNode[] {
	const root = emptyDraft();
	const listed = new Set<string>();
	for (const raw of [...paths, ...changes.map((change) => change.path)]) {
		const path = visibleWorkspacePath(raw);
		if (!path || listed.has(path)) continue;
		listed.add(path);
		const parts = path.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		insertPath(root, parts, fileChangeForPath(changes, path));
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

export function fileTreeChangeMark(
	change: FileChangeEntry["change"] | undefined,
): string | null {
	if (change === "add") return "U";
	if (change === "update") return "M";
	if (change === "delete") return "D";
	return null;
}

function emptyDraft(): DraftDir {
	return { dirs: new Map(), files: new Map() };
}

function insertPath(
	draft: DraftDir,
	parts: readonly string[],
	change: FileChangeEntry | undefined,
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
	insertPath(next, rest, change);
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
			path: change ? visibleWorkspacePath(change.path) : path ? `${path}/${name}` : name,
			...(change ? { change } : {}),
		}));
	return [...dirs, ...files];
}
