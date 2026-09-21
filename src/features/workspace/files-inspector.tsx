import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileChangeEntry } from "#/domain/session-item";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { fileBasename } from "#/domain/file-kind";
import { visibleWorkspacePath } from "#/domain/visible-workspace-path";
import {
	fileEditorSaveHotkey,
	fileEditorSaveShortcut,
} from "#/domain/workspace-explorer";
import {
	fileChangeForPath,
	fileTreeChangeMark,
	firstWorkspaceFilePath,
	type WorkspaceTreeNode,
	workspaceExplorerTree,
} from "#/domain/workspace-file-tree";
import { FileTypeIcon } from "../sessions/file-type-icon";
import { HighlightedCode } from "../sessions/highlighted-code";
import {
	listWorkspaceExplorerFn,
	readWorkspaceSourceFn,
	writeWorkspaceSourceFn,
} from "./explorer.fn";

export function FilesInspector({
	changes,
	selectedPath,
	onSelectPath,
	projectId,
	sessionId,
	active = true,
}: {
	changes: readonly FileChangeEntry[];
	selectedPath?: string;
	onSelectPath: (path: string) => void;
	projectId?: string;
	sessionId?: string;
	active?: boolean;
}) {
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const listExplorer = useServerFn(listWorkspaceExplorerFn);
	const readSource = useServerFn(readWorkspaceSourceFn);
	const explorer = useQuery({
		queryKey: ["workspace-explorer", projectId, sessionId],
		queryFn: () =>
			listExplorer({
				data: { projectId, sessionId },
			}),
		enabled: active && Boolean(projectId && sessionId),
		staleTime: 8_000,
	});
	const tree = workspaceExplorerTree(explorer.data?.paths ?? [], changes);
	const activePath =
		(selectedPath
			? visibleWorkspacePath(
					fileChangeForPath(changes, selectedPath)?.path ?? selectedPath,
				)
			: undefined) ?? firstWorkspaceFilePath(tree);
	const source = useQuery({
		queryKey: ["workspace-source", projectId, sessionId, activePath],
		queryFn: () =>
			readSource({
				data: { projectId, sessionId, path: activePath },
			}),
		enabled: active && Boolean(projectId && sessionId && activePath),
	});
	return (
		<section className="files-inspector" aria-label="Files">
			<FileSourcePreview
				path={activePath}
				text={source.data?.text ?? null}
				pending={source.isPending}
				draft={activePath ? drafts[activePath] : undefined}
				projectId={projectId}
				sessionId={sessionId}
				onDraftChange={(path, next, saved) => {
					setDrafts((current) => {
						if (next === saved) {
							const { [path]: _cleared, ...rest } = current;
							return rest;
						}
						return { ...current, [path]: next };
					});
				}}
			/>
			<nav className="file-tree" aria-label="Workspace files">
				{tree.length === 0 ? (
					<p className="file-tree-empty">
						{explorer.isPending
							? "Loading files…"
							: "The workspace tree will appear here."}
					</p>
				) : (
					<FileTreeNodes
						nodes={tree}
						depth={0}
						selectedPath={activePath}
						onSelectPath={onSelectPath}
					/>
				)}
			</nav>
		</section>
	);
}

function FileSourcePreview({
	path,
	text,
	pending,
	draft,
	projectId,
	sessionId,
	onDraftChange,
}: {
	path?: string;
	text: string | null;
	pending: boolean;
	draft?: string;
	projectId?: string;
	sessionId?: string;
	onDraftChange: (path: string, next: string, saved: string) => void;
}) {
	const queryClient = useQueryClient();
	const writeSource = useServerFn(writeWorkspaceSourceFn);
	const saved = text ?? "";
	const value = draft ?? saved;
	const dirty = draft != null && draft !== saved;
	const shortcut =
		typeof navigator === "undefined"
			? "Ctrl+S"
			: fileEditorSaveShortcut(navigator.platform);
	const save = useMutation({
		mutationFn: async () => {
			if (!path || !dirty) return { ok: true as const, path };
			return writeSource({
				data: { projectId, sessionId, path, text: value },
			});
		},
		onSuccess: async (result) => {
			if (!path || !result.ok) return;
			onDraftChange(path, value, value);
			await queryClient.invalidateQueries({
				queryKey: ["workspace-source", projectId, sessionId, path],
			});
			await queryClient.invalidateQueries({
				queryKey: ["workspace-explorer", projectId, sessionId],
			});
		},
	});
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	if (!path) {
		return (
			<div className="file-editor">
				<p className="diff-preview-empty">Select a file to open it.</p>
			</div>
		);
	}
	if (pending && text == null) {
		return (
			<div className="file-editor" aria-label={path}>
				<p className="diff-preview-empty">Opening {fileBasename(path)}…</p>
			</div>
		);
	}
	if (text == null) {
		return (
			<div className="file-editor" aria-label={path}>
				<p className="diff-preview-empty">
					Wake the workspace to open {fileBasename(path)}.
				</p>
			</div>
		);
	}
	const saveFailed =
		save.data && !save.data.ok
			? save.data.reason === "asleep"
				? "Wake the workspace to save."
				: "Could not save."
			: null;
	return (
		<div className="file-editor" aria-label={path} data-dirty={dirty || undefined}>
			<header className="file-editor-tab">
				<FileTypeIcon path={path} />
				<span>{fileBasename(path)}</span>
				{dirty ? <span className="file-editor-dirty" aria-hidden /> : null}
				{dirty || save.isPending ? (
					<button
						type="button"
						className="file-editor-save"
						disabled={save.isPending || !dirty}
						onClick={() => save.mutate()}
					>
						{save.isPending ? "Saving…" : `Save ${shortcut}`}
					</button>
				) : null}
			</header>
			{saveFailed ? <p className="file-editor-error">{saveFailed}</p> : null}
			<div className="file-editor-pane">
				<pre className="file-editor-source" aria-hidden>
					<HighlightedCode
						text={value.endsWith("\n") ? `${value} ` : value}
						language={sourceLanguageFromPath(path)}
					/>
				</pre>
				<textarea
					className="file-editor-input"
					spellCheck={false}
					wrap="off"
					rows={Math.max(value.split("\n").length, 1)}
					aria-label={fileBasename(path)}
					value={value}
					onChange={(event) => onDraftChange(path, event.target.value, saved)}
					onKeyDown={(event) => {
						if (fileEditorSaveHotkey(event)) {
							event.preventDefault();
							if (dirty && !save.isPending) save.mutate();
						}
					}}
				/>
			</div>
		</div>
	);
}

function FileTreeFile({
	node,
	depth,
	selected,
	onSelectPath,
}: {
	node: Extract<WorkspaceTreeNode, { kind: "file" }>;
	depth: number;
	selected: boolean;
	onSelectPath: (path: string) => void;
}) {
	const mark = fileTreeChangeMark(node.change?.change);
	return (
		<button
			type="button"
			className="file-tree-file"
			data-selected={selected}
			data-change={node.change?.change}
			style={{ paddingLeft: 8 + depth * 12 }}
			onClick={() => onSelectPath(node.path)}
		>
			<FileTypeIcon path={node.path} />
			<span className="file-tree-name">{node.name}</span>
			{mark ? <span className="file-tree-mark">{mark}</span> : null}
		</button>
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
						<FileTreeFile
							node={node}
							depth={depth}
							selected={node.path === selectedPath}
							onSelectPath={onSelectPath}
						/>
					)}
				</li>
			))}
		</ul>
	);
}
