import {
	type QueryClient,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { fileBasename } from "#/domain/file-kind";
import { filePreviewKind } from "#/domain/file-preview";
import type { FileChangeEntry } from "#/domain/session-item";
import { fileEditorSaveShortcut } from "#/domain/workspace-explorer";
import {
	fileChangeForPath,
	fileTreeChangeMark,
	firstWorkspaceFilePath,
	nearbyFiles,
	type WorkspaceTreeNode,
	workspaceExplorerTree,
	workspacePathForMention,
} from "#/domain/workspace-file-tree";
import { finishInteraction } from "../analytics/web-vitals";
import { FileTypeIcon } from "../sessions/file-type-icon";
import {
	listWorkspaceExplorerFn,
	readWorkspaceSourceFn,
	readWorkspaceSourcesFn,
	wakeWorkspaceMachineFn,
	writeWorkspaceSourceFn,
} from "./explorer.fn";
import {
	FilePreview,
	PreviewModeSwitch,
	WorkspaceImagePreview,
} from "./file-preview";
import { readFilesSnapshot, saveFilesSnapshot } from "./files-snapshot";
import { SourceEditorPlaceholder } from "./source-editor-placeholder";

/**
 * The chat's file tree, as Files lists it. The listing also carries the file
 * Files opens first (`open`, or the tree's first file), which goes straight
 * into that file's query, so opening Files is one round trip.
 */
function explorerQuery(
	queryClient: QueryClient,
	projectId?: string,
	sessionId?: string,
	open?: string,
) {
	return queryOptions({
		queryKey: ["workspace-explorer", projectId, sessionId],
		queryFn: async () => {
			const listing = await listWorkspaceExplorerFn({
				data: { projectId, sessionId, path: open },
			});
			if (listing.opened)
				queryClient.setQueryData(
					sourceQuery(projectId, sessionId, listing.opened.path).queryKey,
					listing.opened,
				);
			if (listing.paths.length)
				saveFilesSnapshot(sessionId, {
					root: listing.root,
					paths: listing.paths,
				});
			return listing;
		},
		staleTime: 8_000,
	});
}

/** One file's text, as Files opens it (null when it has no text view). */
function sourceQuery(projectId?: string, sessionId?: string, path?: string) {
	return queryOptions({
		queryKey: ["workspace-source", projectId, sessionId, path],
		queryFn: () =>
			readWorkspaceSourceFn({ data: { projectId, sessionId, path } }),
		// Hover and neighbour reads count as fresh for a moment; an opened file
		// still shows its last text at once and refreshes behind it.
		staleTime: 5_000,
	});
}

/** Reads a file ahead of a click: hovered or focused. */
function prefetchSource(
	queryClient: QueryClient,
	projectId: string | undefined,
	sessionId: string | undefined,
	path: string,
) {
	if (!projectId || !sessionId || filePreviewKind(path) === "image") return;
	void queryClient.prefetchQuery(sourceQuery(projectId, sessionId, path));
}

/** Reads the files next to the open one in one call, skipping any already read. */
async function prefetchSources(
	queryClient: QueryClient,
	projectId: string | undefined,
	sessionId: string | undefined,
	paths: readonly string[],
) {
	const unread = paths.filter(
		(path) =>
			queryClient.getQueryState(
				sourceQuery(projectId, sessionId, path).queryKey,
			)?.status !== "success",
	);
	if (!projectId || !sessionId || unread.length === 0) return;
	const files = await readWorkspaceSourcesFn({
		data: { projectId, sessionId, paths: unread },
	}).catch(() => []);
	for (const [index, file] of files.entries())
		if (file)
			queryClient.setQueryData(
				sourceQuery(projectId, sessionId, unread[index]).queryKey,
				file,
			);
}

/**
 * Reads the chat's file tree and the file Files opens first, before the view
 * opens. A machine that is asleep is read from its disk; nothing is woken.
 */
export async function prefetchWorkspaceFiles(
	queryClient: QueryClient,
	input: {
		readonly projectId: string;
		readonly sessionId: string;
		readonly changes: readonly FileChangeEntry[];
	},
) {
	try {
		const explorer = await queryClient.fetchQuery(
			explorerQuery(
				queryClient,
				input.projectId,
				input.sessionId,
				readFilesSnapshot(input.sessionId)?.opened,
			),
		);
		const path = firstWorkspaceFilePath(
			workspaceExplorerTree(explorer.paths, input.changes),
		);
		if (path && !explorer.opened && !readFilesSnapshot(input.sessionId)?.opened)
			prefetchSource(queryClient, input.projectId, input.sessionId, path);
	} catch {
		// The view reads them again when it opens.
	}
}

const SourceEditor = lazy(() =>
	import("./source-editor").then((module) => ({
		default: module.SourceEditor,
	})),
);

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
	const [treeOpen, setTreeOpen] = useState(true);
	const filesRef = useRef<HTMLElement>(null);
	const wakeMachine = useServerFn(wakeWorkspaceMachineFn);
	const queryClient = useQueryClient();
	const wake = useMutation({
		mutationFn: () => wakeMachine({ data: { projectId, sessionId } }),
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: ["workspace-explorer", projectId, sessionId],
			}),
	});
	// The tree and file this browser last showed for the chat stand in until
	// the server answers.
	const snapshot = useMemo(() => readFilesSnapshot(sessionId), [sessionId]);
	const openHint = selectedPath ?? snapshot?.opened;
	const explorer = useQuery({
		...explorerQuery(queryClient, projectId, sessionId, openHint),
		enabled: active && Boolean(projectId && sessionId),
		// A machine still starting is checked again until the chat has it.
		refetchInterval: (query) =>
			query.state.data?.machine === "starting" ? 3_000 : false,
		placeholderData: snapshot
			? { root: snapshot.root, paths: snapshot.paths }
			: undefined,
	});
	// Files opened until its tree shows (web-vitals.ts).
	const treeShown = active && Boolean(explorer.data);
	useEffect(() => {
		if (treeShown) finishInteraction("files_open");
	}, [treeShown]);
	const tree = workspaceExplorerTree(explorer.data?.paths ?? [], changes);
	const activePath =
		(selectedPath
			? workspacePathForMention(
					fileChangeForPath(changes, selectedPath)?.path ?? selectedPath,
					explorer.data?.paths ?? [],
					changes,
				)
			: undefined) ??
		(explorer.isPlaceholderData ? snapshot?.opened : undefined) ??
		firstWorkspaceFilePath(tree);
	// The listing reads the file it was asked to open; any other waits for nothing.
	const listingReadsActive =
		!explorer.isFetched &&
		Boolean(activePath) &&
		(activePath === openHint || !openHint);
	const source = useQuery({
		...sourceQuery(projectId, sessionId, activePath),
		enabled:
			active &&
			!listingReadsActive &&
			Boolean(projectId && sessionId && activePath) &&
			filePreviewKind(activePath ?? "") !== "image",
	});
	useEffect(() => {
		if (activePath && explorer.isFetched)
			saveFilesSnapshot(sessionId, { opened: activePath });
	}, [activePath, explorer.isFetched, sessionId]);
	// Reads the next couple of files in the tree, once the open one is shown.
	const sourceLoaded = source.data !== undefined;
	const nearby = nearbyFiles(tree, activePath, 3).join("\n");
	useEffect(() => {
		if (!active || !sourceLoaded || !nearby) return;
		const timer = window.setTimeout(
			() =>
				void prefetchSources(
					queryClient,
					projectId,
					sessionId,
					nearby.split("\n"),
				),
			1_000,
		);
		return () => window.clearTimeout(timer);
	}, [active, sourceLoaded, nearby, queryClient, projectId, sessionId]);
	const prefetchFile = (path: string) =>
		prefetchSource(queryClient, projectId, sessionId, path);
	return (
		<section ref={filesRef} className="files-inspector" aria-label="Files">
			<div className="files-toolbar">
				<button
					type="button"
					aria-label={treeOpen ? "Hide file tree" : "Show file tree"}
					title={treeOpen ? "Hide file tree" : "Show file tree"}
					aria-expanded={treeOpen}
					onClick={() => setTreeOpen((open) => !open)}
				>
					{treeOpen ? (
						<PanelRightClose size={16} />
					) : (
						<PanelRightOpen size={16} />
					)}
				</button>
			</div>
			<div className="files-content">
				<FileSourcePreview
					key={activePath}
					path={activePath}
					text={source.data?.text ?? null}
					pending={source.isFetching || listingReadsActive}
					onRetry={() => {
						void explorer.refetch();
						void source.refetch();
					}}
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
				{treeOpen ? (
					<nav className="file-tree" aria-label="Workspace files">
						{explorer.data?.machine ? (
							<div className="file-tree-machine">
								<p>
									{wake.isPending
										? explorer.data.machine === "none"
											? "Setting up this chat's computer. The first time takes a minute or two."
											: explorer.data.machine === "starting"
												? "Starting the machine…"
												: "Waking this chat's computer…"
										: wake.data && !wake.data.ready
											? "This project's environment isn't ready yet."
											: explorer.data.machine === "starting"
												? "Starting the machine…"
												: explorer.data.machine === "none"
													? "This chat doesn't have its own computer yet, so there are no files to show."
													: explorer.data.paths.length
														? "Computer asleep. Wake it to save edits."
														: "This chat's computer is asleep to save minutes."}
									{tree.length && !explorer.data.paths.length && !wake.isPending
										? " Showing this chat's changes only."
										: ""}
								</p>
								<button
									type="button"
									className="file-tree-machine-button"
									disabled={wake.isPending}
									onClick={() => wake.mutate()}
								>
									{explorer.data.machine === "none"
										? "Set up computer"
										: explorer.data.machine === "starting"
											? "Retry"
											: "Wake computer"}
								</button>
								{wake.error ? <p role="alert">{wake.error.message}</p> : null}
							</div>
						) : null}
						{tree.length === 0 ? (
							explorer.data?.machine ? null : (
								<p className="file-tree-empty">
									{explorer.isPending
										? "Loading files…"
										: "No files in this checkout."}
								</p>
							)
						) : (
							<FileTreeNodes
								nodes={tree}
								depth={0}
								selectedPath={activePath}
								onIntent={prefetchFile}
								onSelectPath={(path) => {
									onSelectPath(path);
									if (filesRef.current && filesRef.current.clientWidth <= 600)
										setTreeOpen(false);
								}}
							/>
						)}
					</nav>
				) : null}
			</div>
		</section>
	);
}

function FileSourcePreview({
	path,
	text,
	pending,
	onRetry,
	draft,
	projectId,
	sessionId,
	onDraftChange,
}: {
	path?: string;
	text: string | null;
	pending: boolean;
	onRetry: () => void;
	draft?: string;
	projectId?: string;
	sessionId?: string;
	onDraftChange: (path: string, next: string, saved: string) => void;
}) {
	const queryClient = useQueryClient();
	const previewKind = filePreviewKind(path ?? "");
	const [mode, setMode] = useState<"preview" | "code">(
		previewKind === "code" ? "code" : "preview",
	);
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
	if (previewKind === "image")
		return (
			<section className="file-editor" aria-label={path}>
				<header className="file-editor-tab">
					<FileTypeIcon path={path} />
					<span>{fileBasename(path)}</span>
				</header>
				<div className="file-editor-pane">
					<WorkspaceImagePreview
						path={path}
						projectId={projectId}
						sessionId={sessionId}
					/>
				</div>
			</section>
		);
	if (pending && text == null) {
		return (
			<section className="file-editor" aria-label={path}>
				<p className="diff-preview-empty">Opening {fileBasename(path)}…</p>
			</section>
		);
	}
	if (text == null) {
		return (
			<section className="file-editor" aria-label={path}>
				<p className="diff-preview-empty">
					Could not open {fileBasename(path)}. The file or workspace may be
					unavailable.
				</p>
				<button type="button" className="file-editor-save" onClick={onRetry}>
					Try again
				</button>
			</section>
		);
	}
	const saveFailed =
		save.data && !save.data.ok
			? save.data.reason === "asleep"
				? "Wake the workspace to save."
				: "Could not save."
			: null;
	return (
		<section
			className="file-editor"
			aria-label={path}
			data-dirty={dirty || undefined}
		>
			<header className="file-editor-tab">
				<FileTypeIcon path={path} />
				<span>{fileBasename(path)}</span>
				{previewKind !== "code" ? (
					<PreviewModeSwitch mode={mode} onChange={setMode} />
				) : null}
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
				{mode === "preview" ? (
					<FilePreview path={path} content={{ kind: "text", text: value }} />
				) : (
					<ClientOnly fallback={<SourceEditorPlaceholder value={value} />}>
						<Suspense fallback={<SourceEditorPlaceholder value={value} />}>
							<SourceEditor
								path={path}
								value={value}
								onChange={(next) => onDraftChange(path, next, saved)}
								onSave={() => {
									if (dirty && !save.isPending) save.mutate();
								}}
							/>
						</Suspense>
					</ClientOnly>
				)}
			</div>
		</section>
	);
}

function FileTreeFile({
	node,
	depth,
	selected,
	onSelectPath,
	onIntent,
}: {
	node: Extract<WorkspaceTreeNode, { kind: "file" }>;
	depth: number;
	selected: boolean;
	onSelectPath: (path: string) => void;
	onIntent: (path: string) => void;
}) {
	const mark = fileTreeChangeMark(node.change?.change);
	const hover = useRef<number | undefined>(undefined);
	return (
		<button
			type="button"
			className="file-tree-file"
			data-selected={selected}
			data-change={node.change?.change}
			style={{ paddingLeft: 8 + depth * 12 }}
			onClick={() => onSelectPath(node.path)}
			// A pointer that rests on a file (not one sweeping past) reads it ahead.
			onPointerEnter={() => {
				hover.current = window.setTimeout(() => onIntent(node.path), 60);
			}}
			onPointerLeave={() => window.clearTimeout(hover.current)}
			onFocus={() => onIntent(node.path)}
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
	onIntent,
}: {
	nodes: readonly WorkspaceTreeNode[];
	depth: number;
	selectedPath?: string;
	onSelectPath: (path: string) => void;
	onIntent: (path: string) => void;
}) {
	return (
		<ul className="file-tree-list">
			{nodes.map((node) => (
				<li key={node.path}>
					{node.kind === "dir" ? (
						<details className="file-tree-dir" open>
							<summary style={{ paddingLeft: 8 + depth * 12 }}>
								<ChevronRight size={14} className="session-activity-chevron" />
								<span className="file-tree-name">{node.name}</span>
							</summary>
							<FileTreeNodes
								nodes={node.children}
								depth={depth + 1}
								selectedPath={selectedPath}
								onSelectPath={onSelectPath}
								onIntent={onIntent}
							/>
						</details>
					) : (
						<FileTreeFile
							node={node}
							depth={depth}
							selected={node.path === selectedPath}
							onSelectPath={onSelectPath}
							onIntent={onIntent}
						/>
					)}
				</li>
			))}
		</ul>
	);
}
