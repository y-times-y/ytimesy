import { ChevronRight } from "lucide-react";
import type { FileChangeEntry } from "#/domain/session-item";
import { visibleWorkspacePath } from "#/domain/visible-workspace-path";
import {
	fileChangeForPath,
	firstWorkspaceFilePath,
	type WorkspaceTreeNode,
	workspaceFileTree,
} from "#/domain/workspace-file-tree";
import { FileChangeCounts } from "../sessions/file-change-counts";
import { FileTypeIcon } from "../sessions/file-type-icon";
import { DiffFilePreview } from "./diff-inspector";

export function FilesInspector({
	changes,
	selectedPath,
	onSelectPath,
}: {
	changes: readonly FileChangeEntry[];
	selectedPath?: string;
	onSelectPath: (path: string) => void;
}) {
	const tree = workspaceFileTree(changes);
	const mentioned = selectedPath
		? fileChangeForPath(changes, selectedPath)
		: undefined;
	const activePath =
		(mentioned ? visibleWorkspacePath(mentioned.path) : undefined) ??
		firstWorkspaceFilePath(tree);
	const selected = activePath
		? fileChangeForPath(changes, activePath)
		: undefined;
	return (
		<section className="files-inspector" aria-label="Files">
			<nav className="file-tree" aria-label="Workspace files">
				<FileTreeNodes
					nodes={tree}
					depth={0}
					selectedPath={activePath}
					onSelectPath={onSelectPath}
				/>
			</nav>
			{selected ? (
				<DiffFilePreview change={selected} defaultOpen selected />
			) : (
				<p className="diff-preview-empty">Select a file to open it.</p>
			)}
		</section>
	);
}

function FileTreeNodes({
	nodes,
	depth,
	selectedPath,
	onSelectPath,
}: {
	nodes: readonly WorkspaceTreeNode[];
	depth: number;
	selectedPath?: string;
	onSelectPath: (path: string) => void;
}) {
	return (
		<ul className="file-tree-list">
			{nodes.map((node) => (
				<li key={node.path}>
					{node.kind === "dir" ? (
						<details className="file-tree-dir" open>
							<summary style={{ paddingLeft: 8 + depth * 12 }}>
								<ChevronRight size={12} className="session-activity-chevron" />
								<span className="file-tree-name">{node.name}</span>
							</summary>
							<FileTreeNodes
								nodes={node.children}
								depth={depth + 1}
								selectedPath={selectedPath}
								onSelectPath={onSelectPath}
							/>
						</details>
					) : (
						<button
							type="button"
							className="file-tree-file"
							data-selected={node.path === selectedPath}
							data-change={node.change.change}
							style={{ paddingLeft: 8 + depth * 12 }}
							onClick={() => onSelectPath(node.path)}
						>
							<FileTypeIcon path={node.path} />
							<span className="file-tree-name">{node.name}</span>
							<FileChangeCounts
								additions={node.change.additions}
								deletions={node.change.deletions}
							/>
						</button>
					)}
				</li>
			))}
		</ul>
	);
}
