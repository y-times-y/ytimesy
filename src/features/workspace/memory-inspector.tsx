import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	History,
	List,
	Network,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Switch } from "#/components/ui/switch";
import { DEFAULT_TOPIC, type MemoryEdit } from "#/domain/memory-edit";
import { memoryGraph, nodeId } from "#/domain/memory-graph";
import {
	type MemoryRow,
	type MemoryScope,
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
import { MEMORY_ENTRY, memoryLinks } from "#/domain/memory-repo";
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
	saveMemoryModeFn,
} from "./memory.fn";
import { MemoryDreams } from "./memory-dreams";
import { type MemoryDraft, MemoryEditDialog } from "./memory-edit-dialog";
import { clusterHue, MemoryGraphView } from "./memory-graph-view";
import "./memory-inspector.css";

const today = () => new Date().toISOString().slice(0, 10);

function formatDate(date: string) {
	const parsed = new Date(`${date}T00:00:00Z`);
	return Number.isNaN(parsed.getTime())
		? date
		: parsed.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			});
}

const rowKey = (row: Pick<MemoryRow, "path" | "line">) => nodeId(row);

type DialogState =
	| { mode: "add"; draft: MemoryDraft }
	| { mode: "edit"; row: MemoryRow; draft: MemoryDraft };

/**
 * The user's memory: Personal (lines for every project) and one scope per
 * project, a map of every line, and the lines as an editable list grouped
 * by topic. Add, edit, move between scopes, pin as an always-on rule and
 * delete are each one memory commit. The same view fills the right panel
 * (map behind a toggle) and the full Memory page (map beside the list).
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
	/** The user's projects, for naming scopes and moving lines; read from the projects cache when absent. */
	projects?: readonly Pick<Project, "fullName" | "name">[];
}) {
	const readMemory = useServerFn(readMemoryFn);
	const readDreams = useServerFn(readMemoryDreamsFn);
	const saveMode = useServerFn(saveMemoryModeFn);
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
	const [view, setView] = useState<"list" | "map">("list");
	const [selected, setSelected] = useState<string | null>(null);
	const [focusTopic, setFocusTopic] = useState<string | null>(
		focus?.path ?? null,
	);
	const [dialog, setDialog] = useState<DialogState | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [aspect, setAspect] = useState(layout === "page" ? 1.6 : 1.1);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (focus) {
			setQuery("");
			setScope(null);
			setOrder("topic");
			setView("list");
			setFocusTopic(focus.path);
		}
	}, [focus]);

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["memory"] });
	const toggle = useMutation({
		mutationFn: (mode: "off" | "full") => saveMode({ data: { mode } }),
		onSuccess: () =>
			Promise.all([
				invalidate(),
				queryClient.invalidateQueries({ queryKey: ["memory-dreams"] }),
			]),
	});
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
				if (data.op === "delete" || !dialog) setNotice(result.error);
				return;
			}
			setDialog(null);
			setConfirmDelete(null);
			setNotice(null);
			if (data.op === "delete") setSelected(null);
			return invalidate();
		},
		onError: (error) => {
			if (!dialog) setNotice(error.message);
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
	const scopes = useMemo(() => memoryScopes(rows), [rows]);
	const titles = useMemo(() => topicTitles(repo), [repo]);
	const cachedProjects = queryClient.getQueryData<Project[]>(["projects"]);
	const projectList = knownProjects ?? cachedProjects;
	const projectNames = useMemo(() => {
		const names = new Map<string, { value: string; label: string }>();
		for (const project of projectList ?? [])
			names.set(project.fullName.toLowerCase(), {
				value: project.fullName,
				label: projectDisplayName(project),
			});
		for (const entry of scopes)
			if (entry.project && !names.has(entry.project.toLowerCase()))
				names.set(entry.project.toLowerCase(), {
					value: entry.project,
					label: projectFolderName(entry.project),
				});
		return names;
	}, [projectList, scopes]);
	const scopeTitle = (id: string) =>
		id === PERSONAL_SCOPE
			? "Personal"
			: (projectNames.get(id.slice("project:".length))?.label ??
				id.slice("project:".length));
	const hues = useMemo(
		() =>
			Object.fromEntries(
				scopes.map((entry, index) => [entry.id, clusterHue(index)]),
			),
		[scopes],
	);
	const graph = useMemo(
		() =>
			memoryGraph({
				rows,
				scopes,
				titles,
				today: date,
				scopeTitle: (entry: MemoryScope) => entry.project ?? "Personal",
				aspect,
			}),
		[rows, scopes, titles, date, aspect],
	);

	// Bring the selected row or focused topic into view once it renders.
	useEffect(() => {
		const target = selected
			? listRef.current?.querySelector(`[data-row="${CSS.escape(selected)}"]`)
			: focusTopic
				? listRef.current?.querySelector(
						`[data-topic="${CSS.escape(focusTopic)}"]`,
					)
				: null;
		target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
	}, [selected, focusTopic]);

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
				<p>This server has no memory storage configured.</p>
			</section>
		);
	const on = memory.data.mode !== "off";
	const searching = query.trim().length > 0;
	const inScope = scopeRows(rows, searching ? null : scope);
	const shown = searching
		? searchMemoryRows(scopeRows(rows, null), query)
		: order === "newest"
			? recentMemoryRows(inScope, 500)
			: inScope;
	const groups =
		searching || order === "newest" ? null : rowsByTopic(shown, repo);
	const live = scopeRows(rows, null).filter((row) => !row.replaced);
	const projectChoices = [...projectNames.values()].sort((a, b) =>
		a.label.localeCompare(b.label),
	);
	const topicChoices = Object.entries(titles)
		.filter(([path]) => path !== MEMORY_ENTRY)
		.map(([path, title]) => ({ path, title }))
		.sort((a, b) => a.title.localeCompare(b.title));
	const openAdd = () => {
		const project = scope?.startsWith("project:")
			? (scopes.find((entry) => entry.id === scope)?.project ?? null)
			: null;
		edit.reset();
		setDialog({
			mode: "add",
			draft: {
				text: "",
				project,
				always: false,
				topic:
					focusTopic && focusTopic !== MEMORY_ENTRY && titles[focusTopic]
						? focusTopic
						: DEFAULT_TOPIC,
			},
		});
	};
	const openEdit = (row: MemoryRow) => {
		edit.reset();
		setDialog({
			mode: "edit",
			row,
			draft: {
				text: row.text,
				project: row.project ?? null,
				always: row.rule,
				topic: row.path,
			},
		});
	};
	const ref = (row: MemoryRow) => ({
		path: row.path,
		line: row.line,
		text: row.text,
	});
	const selectRow = (key: string) => {
		setSelected(key);
		setView("list");
		const row = rows.find((candidate) => rowKey(candidate) === key);
		if (row && scope && rowScope(row) !== scope && !searching) setScope(null);
	};
	const rowItem = (row: MemoryRow, showTopic: boolean) => (
		<MemoryRowItem
			key={rowKey(row)}
			row={row}
			selected={selected === rowKey(row)}
			showScope={scope === null || searching}
			showTopic={showTopic}
			scopeLabel={scopeTitle(rowScope(row))}
			scopeHue={hues[rowScope(row)]}
			topicTitle={titles[row.path] ?? row.path}
			topics={repo}
			busy={edit.isPending}
			confirmingDelete={confirmDelete === rowKey(row)}
			onSelect={() => setSelected(rowKey(row))}
			onOpenTopic={(path) => {
				setQuery("");
				setOrder("topic");
				setFocusTopic(path);
			}}
			onOpenChat={onOpenChat}
			onEdit={() => openEdit(row)}
			onTogglePin={() =>
				edit.mutate({ op: "update", ref: ref(row), always: !row.rule })
			}
			onAskDelete={() => setConfirmDelete(rowKey(row))}
			onCancelDelete={() => setConfirmDelete(null)}
			onDelete={() => edit.mutate({ op: "delete", ref: ref(row) })}
		/>
	);
	const scopeChips = (
		<div className="memory-scopes" role="toolbar" aria-label="Scope">
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
							? `Lines tagged project: ${entry.project} apply only in that project.`
							: "Lines without a project apply in every project."
					}
					onClick={() => setScope(scope === entry.id ? null : entry.id)}
				>
					<i style={{ background: hues[entry.id] }} aria-hidden="true" />
					{scopeTitle(entry.id)} <span>{entry.count}</span>
				</button>
			))}
		</div>
	);
	return (
		<section
			className="memory-inspector"
			data-layout={layout}
			data-view={view}
			aria-label="Memory"
		>
			<div className="memory-toolbar">
				<label className="memory-search">
					<Search size={14} aria-hidden="true" />
					<input
						type="search"
						placeholder="Search memory"
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
				{live.length ? (
					<fieldset className="memory-view-toggle" aria-label="Show memory as">
						<button
							type="button"
							aria-pressed={view === "list"}
							onClick={() => setView("list")}
						>
							<List size={14} aria-hidden="true" /> List
						</button>
						<button
							type="button"
							aria-pressed={view === "map"}
							onClick={() => setView("map")}
						>
							<Network size={14} aria-hidden="true" /> Map
						</button>
					</fieldset>
				) : null}
				<button type="button" className="memory-primary" onClick={openAdd}>
					<Plus size={14} aria-hidden="true" /> Add memory
				</button>
			</div>
			<div className="memory-settings">
				<div className="memory-use">
					<Switch
						id="memory-use-switch"
						checked={on}
						disabled={toggle.isPending}
						onCheckedChange={(checked) =>
							toggle.mutate(checked ? "full" : "off")
						}
					/>
					<div>
						<label htmlFor="memory-use-switch">Use memory</label>
						<p>
							When off, nothing is recalled into chats and nothing new is saved.
						</p>
					</div>
				</div>
				{confirmClear ? (
					<div className="memory-actions">
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
					</div>
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
			{!live.length ? (
				<div className="inspector-empty memory-empty">
					<h2>No memory yet.</h2>
					<p>
						The agent saves your preferences, decisions and corrections here as
						you chat, so later chats don't need them repeated. You can also add
						one yourself.
					</p>
					<div className="memory-dreams-slot" data-slot="empty">
						<MemoryDreams status={dreams.data} />
					</div>
				</div>
			) : (
				<div className="memory-body">
					<div className="memory-map-column">
						<MemoryGraphView
							graph={graph}
							hues={hues}
							scopeFilter={searching ? null : scope}
							selected={selected}
							onSelectNode={(node) => selectRow(node.id)}
							onSelectScope={(id) => {
								setScope(id);
								setQuery("");
							}}
							topicTitle={(path) => titles[path] ?? path}
							scopeTitle={scopeTitle}
							onAspect={setAspect}
						/>
						<div className="memory-dreams-slot" data-slot="map">
							<MemoryDreams status={dreams.data} />
						</div>
					</div>
					<div className="memory-list-column" ref={listRef}>
						<div className="memory-list-head">
							{searching ? (
								<h3>
									{shown.length} {shown.length === 1 ? "match" : "matches"}
								</h3>
							) : (
								scopeChips
							)}
							{searching ? null : (
								<fieldset className="memory-order" aria-label="Order lines">
									<button
										type="button"
										aria-pressed={order === "topic"}
										onClick={() => setOrder("topic")}
									>
										By topic
									</button>
									<button
										type="button"
										aria-pressed={order === "newest"}
										onClick={() => setOrder("newest")}
									>
										Newest
									</button>
								</fieldset>
							)}
						</div>
						{scope && !searching ? (
							<p className="memory-scope-note">
								{scope === PERSONAL_SCOPE
									? "Personal lines apply in every project."
									: `These lines apply only in ${scopeTitle(scope)}.`}
							</p>
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
								{searching
									? "No memory line matches."
									: "No lines in this scope yet."}
							</p>
						)}
						<div className="memory-dreams-slot" data-slot="list">
							<MemoryDreams status={dreams.data} />
						</div>
					</div>
				</div>
			)}
			{dialog ? (
				<MemoryEditDialog
					mode={dialog.mode}
					initial={dialog.draft}
					projects={projectChoices}
					topics={topicChoices}
					pending={edit.isPending}
					error={
						edit.data && !edit.data.ok
							? edit.data.error
							: (edit.error?.message ?? undefined)
					}
					onClose={() => setDialog(null)}
					onSave={(draft) => {
						if (dialog.mode === "add")
							edit.mutate({
								op: "add",
								text: draft.text,
								project: draft.project,
								always: draft.always,
								topic: draft.topic,
							});
						else {
							const { row } = dialog;
							edit.mutate({
								op: "update",
								ref: ref(row),
								...(draft.text.trim() !== row.text ? { text: draft.text } : {}),
								...((draft.project ?? "") !== (row.project ?? "")
									? { project: draft.project }
									: {}),
								...(draft.always !== row.rule ? { always: draft.always } : {}),
							});
						}
					}}
				/>
			) : null}
		</section>
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
					title={`History of ${path}`}
					onClick={() => setShowHistory((value) => !value)}
				>
					<History size={13} aria-hidden="true" /> History
				</button>
			</header>
			{showHistory ? (
				<ol className="memory-history">
					{history.isPending ? (
						<li className="memory-muted">Loading history…</li>
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

/** One memory line: text with marks, muted details, and its edit actions. */
function MemoryRowItem({
	row,
	selected,
	showScope,
	showTopic,
	scopeLabel,
	scopeHue,
	topicTitle,
	topics,
	busy,
	confirmingDelete,
	onSelect,
	onOpenTopic,
	onOpenChat,
	onEdit,
	onTogglePin,
	onAskDelete,
	onCancelDelete,
	onDelete,
}: {
	row: MemoryRow;
	selected: boolean;
	showScope: boolean;
	showTopic: boolean;
	scopeLabel: string;
	scopeHue?: string;
	topicTitle: string;
	topics: Readonly<Record<string, string>>;
	busy: boolean;
	confirmingDelete: boolean;
	onSelect: () => void;
	onOpenTopic: (path: string) => void;
	onOpenChat: (chatId: string) => boolean;
	onEdit: () => void;
	onTogglePin: () => void;
	onAskDelete: () => void;
	onCancelDelete: () => void;
	onDelete: () => void;
}) {
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
			data-selected={selected ? "true" : undefined}
			data-replaced={row.replaced ? "true" : undefined}
			data-rule={row.rule && !row.replaced ? "true" : undefined}
			onPointerDown={onSelect}
		>
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
			<div className="memory-row-foot">
				<p className="memory-row-meta">
					{showScope ? (
						<span className="memory-row-scope">
							<i style={{ background: scopeHue }} aria-hidden="true" />
							{scopeLabel}
						</span>
					) : null}
					{showTopic ? (
						<button
							type="button"
							className="memory-row-action"
							onClick={() => onOpenTopic(row.path)}
						>
							{topicTitle}
						</button>
					) : null}
					<span>{row.kind === "inferred" ? "Inferred" : "Stated"}</span>
					{row.expires ? <span>until {row.expires}</span> : null}
					{row.added ? <span>{formatDate(row.added)}</span> : null}
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
				{confirmingDelete ? (
					<span className="memory-row-confirm">
						Delete this line?
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
									aria-label="Edit or move"
									title="Edit or move"
									disabled={busy}
									onClick={onEdit}
								>
									<Pencil size={13} />
								</button>
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
