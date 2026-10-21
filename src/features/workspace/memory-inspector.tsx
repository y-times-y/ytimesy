import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	ChevronDown,
	FolderInput,
	History,
	Pencil,
	Pin,
	PinOff,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	MEMORY_EDIT_TEXT_MAX,
	type MemoryEdit,
	type MemoryLineRef,
} from "#/domain/memory-edit";
import {
	type MemoryRow,
	memoryRows,
	memoryScopes,
	PERSONAL_SCOPE,
	recentMemoryRows,
	rowScope,
	rowsByTopic,
	scopeRows,
	searchMemoryRows,
	topicTitles,
} from "#/domain/memory-overview";
import { memoryLinks } from "#/domain/memory-repo";
import {
	type Project,
	projectDisplayName,
	projectFolderName,
} from "#/domain/projects";
import {
	clearMemoryFn,
	editMemoryFn,
	readMemoryDreamsFn,
	readMemoryFn,
	readMemoryHistoryFn,
} from "./memory.fn";
import { MemoryDreams } from "./memory-dreams";
import { type MemoryMenuChoice, MemoryScopeMenu } from "./memory-menu";
import "./memory-inspector.css";

const today = () => new Date().toISOString().slice(0, 10);
/** How long a just-added line stays on top with its Undo. */
const UNDO_MS = 8000;

export function formatMemoryDate(date: string) {
	const parsed = new Date(`${date}T00:00:00Z`);
	return Number.isNaN(parsed.getTime())
		? date
		: parsed.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			});
}

const rowKey = (row: Pick<MemoryRow, "path" | "line">) =>
	`${row.path}:${row.line}`;
export const memoryLineRef = (row: MemoryRow): MemoryLineRef => ({
	path: row.path,
	line: row.line,
	text: row.text,
});

/** Scope names: Personal, then each project by its display name. */
export function useMemoryScopeNames(
	rows: readonly MemoryRow[],
	knownProjects?: readonly Pick<Project, "fullName" | "name">[],
) {
	const queryClient = useQueryClient();
	const projectList =
		knownProjects ?? queryClient.getQueryData<Project[]>(["projects"]);
	const scopes = useMemo(() => memoryScopes(rows), [rows]);
	const names = useMemo(() => {
		const map = new Map<string, { value: string; label: string }>();
		for (const project of projectList ?? [])
			map.set(project.fullName.toLowerCase(), {
				value: project.fullName,
				label: projectDisplayName(project),
			});
		for (const entry of scopes)
			if (entry.project && !map.has(entry.project.toLowerCase()))
				map.set(entry.project.toLowerCase(), {
					value: entry.project,
					label: projectFolderName(entry.project),
				});
		return map;
	}, [projectList, scopes]);
	const scopeTitle = (id: string) =>
		id === PERSONAL_SCOPE
			? "Personal"
			: (names.get(id.slice("project:".length))?.label ??
				id.slice("project:".length));
	/** Where a line can live: Personal, then every known project. */
	const choices: MemoryMenuChoice[] = [
		{ value: null, label: "Personal", hint: "every project" },
		...[...names.values()]
			.sort((a, b) => a.label.localeCompare(b.label))
			.map((name) => ({ value: name.value, label: name.label })),
	];
	const projectLabel = (project: string | null) =>
		project
			? (names.get(project.toLowerCase())?.label ?? projectFolderName(project))
			: "Personal";
	return { scopes, scopeTitle, choices, projectLabel };
}

/**
 * The user's memory as a list: a one-line composer, Personal and each
 * project as scopes, lines by topic with inline edit, move, pin and delete
 * (each one memory commit), and a short Dreaming card. The same view fills
 * the right panel and the Memory page; the graph has its own page.
 */
export function MemoryInspector({
	active,
	focus,
	onOpenChat,
	layout = "panel",
	projects: knownProjects,
}: {
	active: boolean;
	/** A file a chat's memory marker opened; each new request shows it again. */
	focus?: { path: string };
	onOpenChat: (chatId: string) => boolean;
	/** "page": the full-page Memory view from the left sidebar. */
	layout?: "panel" | "page";
	projects?: readonly Pick<Project, "fullName" | "name">[];
}) {
	const readMemory = useServerFn(readMemoryFn);
	const readDreams = useServerFn(readMemoryDreamsFn);
	const clearMemory = useServerFn(clearMemoryFn);
	const editMemory = useServerFn(editMemoryFn);
	const queryClient = useQueryClient();
	const memory = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: active,
	});
	const dreams = useQuery({
		queryKey: ["memory-dreams"],
		queryFn: () => readDreams(),
		enabled: active && Boolean(memory.data?.available),
		staleTime: 60_000,
	});
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<string | null>(null);
	const [order, setOrder] = useState<"topic" | "newest">("topic");
	const [focusTopic, setFocusTopic] = useState<string | null>(
		focus?.path ?? null,
	);
	const [editing, setEditing] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [justAdded, setJustAdded] = useState<MemoryLineRef | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (focus) {
			setQuery("");
			setScope(null);
			setOrder("topic");
			setFocusTopic(focus.path);
		}
	}, [focus]);
	useEffect(() => {
		if (!justAdded) return;
		const timer = setTimeout(() => setJustAdded(null), UNDO_MS);
		return () => clearTimeout(timer);
	}, [justAdded]);
	useEffect(() => {
		if (!focusTopic) return;
		listRef.current
			?.querySelector(`[data-topic="${CSS.escape(focusTopic)}"]`)
			?.scrollIntoView?.({ block: "start", behavior: "smooth" });
	}, [focusTopic]);

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["memory"] });
	const clear = useMutation({
		mutationFn: () => clearMemory(),
		onSuccess: () => {
			setConfirmClear(false);
			setScope(null);
			return invalidate();
		},
	});
	const edit = useMutation({
		mutationFn: (data: MemoryEdit) => editMemory({ data }),
		onSuccess: (result, data) => {
			if (!result.ok) {
				if (data.op !== "add") setNotice(result.error);
				return;
			}
			setEditing(null);
			setConfirmDelete(null);
			setNotice(null);
			if (data.op === "add" && result.added) setJustAdded(result.added);
			if (data.op === "delete" && justAdded?.text === data.ref.text)
				setJustAdded(null);
			return invalidate();
		},
		onError: (error, data) => {
			if (data.op !== "add") setNotice(error.message);
		},
	});

	const files = memory.data?.files;
	const repo = useMemo(
		() =>
			Object.fromEntries(
				(files ?? []).map((file) => [file.path, file.content]),
			),
		[files],
	);
	const date = today();
	const rows = useMemo(() => memoryRows(repo, date), [repo, date]);
	const titles = useMemo(() => topicTitles(repo), [repo]);
	const { scopes, scopeTitle, choices, projectLabel } = useMemoryScopeNames(
		rows,
		knownProjects,
	);

	if (memory.isPending)
		return (
			<section className="memory-inspector memory-muted memory-loading">
				Loading memory…
			</section>
		);
	if (memory.isError || !memory.data?.available)
		return (
			<section className="inspector-empty" aria-live="polite">
				<h2>Memory is unavailable.</h2>
				<p>No memory storage on this server.</p>
			</section>
		);
	const searching = query.trim().length > 0;
	const all = scopeRows(rows, null);
	const live = all.filter((row) => !row.replaced);
	const added = justAdded
		? all.find(
				(row) => row.path === justAdded.path && row.text === justAdded.text,
			)
		: undefined;
	const inScope = scopeRows(rows, searching ? null : scope).filter(
		(row) => row !== added,
	);
	const shown = searching
		? searchMemoryRows(all, query)
		: order === "newest"
			? recentMemoryRows(inScope, 500)
			: inScope;
	const groups =
		searching || order === "newest" ? null : rowsByTopic(shown, repo);
	const defaultProject = scope?.startsWith("project:")
		? (scopes.find((entry) => entry.id === scope)?.project ?? null)
		: null;
	const rowItem = (row: MemoryRow, showTopic: boolean, fresh = false) => (
		<MemoryRowItem
			key={rowKey(row)}
			row={row}
			fresh={fresh}
			showScope={scope === null || searching}
			showTopic={showTopic}
			scopeLabel={scopeTitle(rowScope(row))}
			topicTitle={titles[row.path] ?? row.path}
			topics={repo}
			choices={choices}
			busy={edit.isPending}
			editing={editing === rowKey(row)}
			confirmingDelete={confirmDelete === rowKey(row)}
			onOpenTopic={(path) => {
				setQuery("");
				setOrder("topic");
				setFocusTopic(path);
			}}
			onOpenChat={onOpenChat}
			onStartEdit={() => {
				setEditing(rowKey(row));
				setConfirmDelete(null);
			}}
			onCancelEdit={() => setEditing(null)}
			onSaveText={(text) =>
				edit.mutate({ op: "update", ref: memoryLineRef(row), text })
			}
			onMove={(project) =>
				edit.mutate({ op: "update", ref: memoryLineRef(row), project })
			}
			onTogglePin={() =>
				edit.mutate({
					op: "update",
					ref: memoryLineRef(row),
					always: !row.rule,
				})
			}
			onAskDelete={() => setConfirmDelete(rowKey(row))}
			onCancelDelete={() => setConfirmDelete(null)}
			onDelete={() => edit.mutate({ op: "delete", ref: memoryLineRef(row) })}
			onUndo={
				fresh
					? () => edit.mutate({ op: "delete", ref: memoryLineRef(row) })
					: undefined
			}
		/>
	);
	const addError =
		edit.variables?.op === "add"
			? edit.data && !edit.data.ok
				? edit.data.error
				: edit.error?.message
			: undefined;
	return (
		<section
			className="memory-inspector"
			data-layout={layout}
			aria-label="Memory"
		>
			<div className="memory-main">
				<MemoryComposer
					key={defaultProject ?? PERSONAL_SCOPE}
					compact={layout === "panel"}
					choices={choices}
					projectLabel={projectLabel}
					initialProject={defaultProject}
					pending={edit.isPending && edit.variables?.op === "add"}
					error={addError}
					onSave={(draft) =>
						edit
							.mutateAsync({ op: "add", ...draft })
							.then((result) => result.ok)
					}
				/>
				{notice ? (
					<p className="memory-notice" role="alert">
						{notice}
						<button
							type="button"
							aria-label="Dismiss"
							onClick={() => setNotice(null)}
						>
							<X size={12} />
						</button>
					</p>
				) : null}
				{!live.length && !added ? (
					<div className="memory-empty">
						<h2>No memory yet.</h2>
						<p>Tell it something above, or just chat.</p>
					</div>
				) : (
					<div className="memory-list" ref={listRef}>
						<div className="memory-list-head">
							{searching ? (
								<h3 className="memory-matches">
									{shown.length} {shown.length === 1 ? "match" : "matches"}
								</h3>
							) : (
								<div
									className="memory-scopes"
									role="toolbar"
									aria-label="Scope"
								>
									<button
										type="button"
										className="memory-chip"
										aria-pressed={scope === null}
										onClick={() => setScope(null)}
									>
										All <span>{live.length}</span>
									</button>
									{scopes.map((entry) => (
										<button
											key={entry.id}
											type="button"
											className="memory-chip"
											aria-pressed={scope === entry.id}
											title={
												entry.project
													? `Only in ${scopeTitle(entry.id)}`
													: "Every project"
											}
											onClick={() =>
												setScope(scope === entry.id ? null : entry.id)
											}
										>
											{scopeTitle(entry.id)} <span>{entry.count}</span>
										</button>
									))}
								</div>
							)}
							<div className="memory-list-tools">
								<label className="memory-search">
									<Search size={13} aria-hidden="true" />
									<input
										type="search"
										placeholder="Search"
										aria-label="Search memory"
										value={query}
										onChange={(event) => setQuery(event.target.value)}
									/>
									{query ? (
										<button
											type="button"
											className="memory-search-clear"
											aria-label="Clear search"
											onClick={() => setQuery("")}
										>
											<X size={12} />
										</button>
									) : null}
								</label>
								<fieldset className="memory-order" aria-label="Order lines">
									<button
										type="button"
										aria-pressed={order === "topic"}
										onClick={() => setOrder("topic")}
									>
										Topics
									</button>
									<button
										type="button"
										aria-pressed={order === "newest"}
										onClick={() => setOrder("newest")}
									>
										Newest
									</button>
								</fieldset>
							</div>
						</div>
						{added ? (
							<ul className="memory-rows memory-just-added">
								{rowItem(added, true, true)}
							</ul>
						) : null}
						{groups ? (
							groups.map((group) => (
								<TopicGroup
									key={group.path}
									path={group.path}
									title={group.title}
									count={group.rows.filter((row) => !row.replaced).length}
									content={repo[group.path] ?? ""}
									focused={focusTopic === group.path}
								>
									<ul className="memory-rows">
										{group.rows.map((row) => rowItem(row, false))}
									</ul>
								</TopicGroup>
							))
						) : shown.length ? (
							<ul className="memory-rows">
								{shown.map((row) => rowItem(row, true))}
							</ul>
						) : (
							<p className="memory-muted memory-list-empty">
								{searching ? "No matches." : "Nothing here yet."}
							</p>
						)}
					</div>
				)}
			</div>
			<aside className="memory-side">
				<MemoryDreams status={dreams.data} />
				<div className="memory-clear">
					{confirmClear ? (
						<>
							<button
								type="button"
								className="memory-danger"
								disabled={clear.isPending}
								onClick={() => clear.mutate()}
							>
								Delete all memory
							</button>
							<button type="button" onClick={() => setConfirmClear(false)}>
								Cancel
							</button>
						</>
					) : (
						<button
							type="button"
							className="memory-quiet"
							aria-label="Clear memory"
							disabled={!files?.length}
							onClick={() => setConfirmClear(true)}
						>
							<Trash2 size={13} aria-hidden="true" /> Clear all
						</button>
					)}
				</div>
			</aside>
		</section>
	);
}

/**
 * One line to add a memory: Enter saves (Shift+Enter is a new line), a
 * scope chip and an Always on chip beside it; the topic is chosen for it.
 */
function MemoryComposer({
	compact,
	choices,
	projectLabel,
	initialProject,
	pending,
	error,
	onSave,
}: {
	compact: boolean;
	choices: readonly MemoryMenuChoice[];
	projectLabel: (project: string | null) => string;
	initialProject: string | null;
	pending: boolean;
	error?: string;
	onSave: (draft: {
		text: string;
		project: string | null;
		always: boolean;
	}) => Promise<boolean>;
}) {
	const [text, setText] = useState("");
	const [project, setProject] = useState<string | null>(initialProject);
	const [always, setAlways] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const save = async () => {
		if (!text.trim() || pending) return;
		if (await onSave({ text, project, always }).catch(() => false)) {
			setText("");
			setAlways(false);
		}
	};
	// Grow with the text, one line when empty.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the text changes.
	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;
	}, [text]);
	return (
		<form
			className="memory-composer"
			data-compact={compact ? "true" : undefined}
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<textarea
				ref={input}
				rows={1}
				maxLength={MEMORY_EDIT_TEXT_MAX}
				aria-label="New memory"
				placeholder="Tell the agent something to remember…"
				value={text}
				disabled={pending}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						void save();
					}
				}}
			/>
			<div className="memory-composer-row">
				<MemoryScopeMenu
					label="Applies to"
					choices={choices}
					value={project}
					onChoose={setProject}
				>
					<button
						type="button"
						className="memory-pill"
						aria-label={`Applies to ${projectLabel(project)}`}
					>
						{projectLabel(project)}
						<ChevronDown size={12} aria-hidden="true" />
					</button>
				</MemoryScopeMenu>
				<button
					type="button"
					className="memory-pill"
					aria-pressed={always}
					title="Attach to every chat, whatever the request"
					onClick={() => setAlways((value) => !value)}
				>
					<Pin size={12} aria-hidden="true" />
					Always on
				</button>
				<span className="memory-composer-hint">
					{pending ? "Saving…" : text.trim() ? "Enter to save" : ""}
				</span>
			</div>
			{error ? (
				<p className="memory-composer-error" role="alert">
					{error}
				</p>
			) : null}
		</form>
	);
}

/** A topic's heading with its line count and, on request, its file's history. */
function TopicGroup({
	path,
	title,
	count,
	content,
	focused,
	children,
}: {
	path: string;
	title: string;
	count: number;
	content: string;
	focused: boolean;
	children: ReactNode;
}) {
	const [showHistory, setShowHistory] = useState(false);
	const readHistory = useServerFn(readMemoryHistoryFn);
	const history = useQuery({
		queryKey: ["memory-history", path, content],
		queryFn: () => readHistory({ data: { path } }),
		enabled: showHistory,
	});
	return (
		<section
			className="memory-topic-group"
			data-topic={path}
			data-focused={focused ? "true" : undefined}
		>
			<header>
				<h3>
					{title} <span className="memory-muted">{count}</span>
				</h3>
				<button
					type="button"
					className="memory-quiet"
					aria-pressed={showHistory}
					aria-label={`History of ${title}`}
					title="History"
					onClick={() => setShowHistory((value) => !value)}
				>
					<History size={13} aria-hidden="true" />
				</button>
			</header>
			{showHistory ? (
				<ol className="memory-history">
					{history.isPending ? (
						<li className="memory-muted">Loading…</li>
					) : (
						(history.data ?? []).map((commit) => (
							<li key={commit.hash}>
								<div>
									<strong>{commit.message}</strong>{" "}
									<span className="memory-muted">
										{new Date(commit.committedAt).toLocaleString()}
									</span>
								</div>
								<pre>
									{commit.patch.split("\n").map((line, index) => (
										<span
											// biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed patch.
											key={index}
											data-change={
												line.startsWith("+")
													? "add"
													: line.startsWith("-")
														? "delete"
														: undefined
											}
										>
											{line}
											{"\n"}
										</span>
									))}
								</pre>
							</li>
						))
					)}
				</ol>
			) : (
				children
			)}
		</section>
	);
}

/** One memory line: text (edited in place), muted details, and its actions. */
function MemoryRowItem({
	row,
	fresh,
	showScope,
	showTopic,
	scopeLabel,
	topicTitle,
	topics,
	choices,
	busy,
	editing,
	confirmingDelete,
	onOpenTopic,
	onOpenChat,
	onStartEdit,
	onCancelEdit,
	onSaveText,
	onMove,
	onTogglePin,
	onAskDelete,
	onCancelDelete,
	onDelete,
	onUndo,
}: {
	row: MemoryRow;
	fresh: boolean;
	showScope: boolean;
	showTopic: boolean;
	scopeLabel: string;
	topicTitle: string;
	topics: Readonly<Record<string, string>>;
	choices: readonly MemoryMenuChoice[];
	busy: boolean;
	editing: boolean;
	confirmingDelete: boolean;
	onOpenTopic: (path: string) => void;
	onOpenChat: (chatId: string) => boolean;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSaveText: (text: string) => void;
	onMove: (project: string | null) => void;
	onTogglePin: () => void;
	onAskDelete: () => void;
	onCancelDelete: () => void;
	onDelete: () => void;
	onUndo?: () => void;
}) {
	const [draft, setDraft] = useState(row.text);
	useEffect(() => {
		if (editing) setDraft(row.text);
	}, [editing, row.text]);
	const inline = (text: string) =>
		text.split(/(\[\[[^\]]+\]\])/g).map((part, index) => {
			const target = /^\[\[([^\]]+)\]\]$/.exec(part)?.[1];
			if (!target) return part;
			const resolved = memoryLinks(part)[0];
			return topics[resolved] !== undefined ? (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed line.
					key={index}
					type="button"
					className="memory-link"
					onClick={() => onOpenTopic(resolved)}
				>
					{target}
				</button>
			) : (
				// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed line.
				<span key={index} className="memory-muted">
					{target}
				</span>
			);
		});
	const pinLabel = row.rule ? "Unpin always-on rule" : "Pin as always-on rule";
	return (
		<li
			className="memory-row"
			data-row={rowKey(row)}
			data-fresh={fresh ? "true" : undefined}
			data-replaced={row.replaced ? "true" : undefined}
		>
			{editing ? (
				<textarea
					className="memory-row-edit"
					aria-label="Memory text"
					maxLength={MEMORY_EDIT_TEXT_MAX}
					value={draft}
					// biome-ignore lint/a11y/noAutofocus: the user just asked to edit this line.
					autoFocus
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onCancelEdit();
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							if (draft.trim() && draft.trim() !== row.text) onSaveText(draft);
							else onCancelEdit();
						}
					}}
				/>
			) : (
				<p className="memory-row-text">
					{row.rule && !row.replaced ? (
						<span className="memory-badge">
							<Pin size={10} aria-hidden="true" /> Always on
						</span>
					) : null}
					{row.replaced ? (
						<span className="memory-badge" data-tone="replaced">
							Replaced
						</span>
					) : null}
					<span>{inline(row.text)}</span>
				</p>
			)}
			<div className="memory-row-foot">
				<p className="memory-row-meta">
					{showScope ? <span>{scopeLabel}</span> : null}
					{showTopic ? (
						<button
							type="button"
							className="memory-row-action"
							onClick={() => onOpenTopic(row.path)}
						>
							{topicTitle}
						</button>
					) : null}
					{row.kind === "inferred" ? <span>Inferred</span> : null}
					{row.expires ? <span>until {row.expires}</span> : null}
					{row.added ? <span>{formatMemoryDate(row.added)}</span> : null}
					{row.chatId ? (
						<a
							className="memory-row-action"
							href={`/?chat=${row.chatId}`}
							onClick={(event) => {
								if (row.chatId && onOpenChat(row.chatId))
									event.preventDefault();
							}}
						>
							Open chat
						</a>
					) : null}
				</p>
				{onUndo ? (
					<span className="memory-row-confirm">
						Saved
						<button type="button" disabled={busy} onClick={onUndo}>
							Undo
						</button>
					</span>
				) : confirmingDelete ? (
					<span className="memory-row-confirm">
						Delete?
						<button
							type="button"
							className="memory-danger"
							disabled={busy}
							onClick={onDelete}
						>
							Delete
						</button>
						<button type="button" onClick={onCancelDelete}>
							Cancel
						</button>
					</span>
				) : editing ? (
					<span className="memory-row-confirm">
						<button
							type="button"
							disabled={busy || !draft.trim() || draft.trim() === row.text}
							onClick={() => onSaveText(draft)}
						>
							Save
						</button>
						<button type="button" onClick={onCancelEdit}>
							Cancel
						</button>
					</span>
				) : (
					<span className="memory-row-tools">
						{row.replaced ? null : (
							<>
								<button
									type="button"
									className="memory-icon-button"
									aria-label={pinLabel}
									title={pinLabel}
									aria-pressed={row.rule}
									disabled={busy}
									onClick={onTogglePin}
								>
									{row.rule ? <PinOff size={13} /> : <Pin size={13} />}
								</button>
								<button
									type="button"
									className="memory-icon-button"
									aria-label="Edit"
									title="Edit"
									disabled={busy}
									onClick={onStartEdit}
								>
									<Pencil size={13} />
								</button>
								<MemoryScopeMenu
									label="Move to"
									choices={choices}
									value={row.project ?? null}
									align="end"
									onChoose={(project) => {
										if ((project ?? "") !== (row.project ?? ""))
											onMove(project);
									}}
								>
									<button
										type="button"
										className="memory-icon-button"
										aria-label="Move"
										title="Move"
										disabled={busy}
									>
										<FolderInput size={13} />
									</button>
								</MemoryScopeMenu>
							</>
						)}
						<button
							type="button"
							className="memory-icon-button"
							aria-label="Delete"
							title="Delete"
							disabled={busy}
							onClick={onAskDelete}
						>
							<Trash2 size={13} />
						</button>
					</span>
				)}
			</div>
		</li>
	);
}
