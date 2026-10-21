import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock3, History, Pin, Search, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	type MemoryRow,
	memoryRows,
	memoryTopics,
	RULES_TOPIC,
	recentMemoryRows,
	searchMemoryRows,
	topicRows,
} from "#/domain/memory-overview";
import { MEMORY_ENTRY, memoryLinks } from "#/domain/memory-repo";
import {
	clearMemoryFn,
	readMemoryFn,
	readMemoryHistoryFn,
	saveMemoryModeFn,
	undoMemoryLineFn,
} from "./memory.fn";
import "./memory-inspector.css";

/** The recent feed's id in the topic list. */
const RECENT = "recent";

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

/**
 * The user's memory: a topic list (project rules pinned first), a feed of
 * the newest lines, the selected topic's lines as rows, and a search across
 * every line. The same view fills the right panel and the Memory page.
 */
export function MemoryInspector({
	active,
	focus,
	onOpenChat,
	layout = "panel",
}: {
	active: boolean;
	/** A file a chat's memory marker opened; each new request selects it again. */
	focus?: { path: string };
	onOpenChat: (chatId: string) => boolean;
	/** "page": the full-page Memory view from the left sidebar. */
	layout?: "panel" | "page";
}) {
	const readMemory = useServerFn(readMemoryFn);
	const saveMode = useServerFn(saveMemoryModeFn);
	const clearMemory = useServerFn(clearMemoryFn);
	const undoLine = useServerFn(undoMemoryLineFn);
	const queryClient = useQueryClient();
	const memory = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: active,
	});
	const [selected, setSelected] = useState<string>(focus?.path ?? RECENT);
	const [query, setQuery] = useState("");
	useEffect(() => {
		if (focus) {
			setSelected(focus.path);
			setQuery("");
		}
	}, [focus]);
	const [confirmClear, setConfirmClear] = useState(false);
	const toggle = useMutation({
		mutationFn: (mode: "off" | "full") => saveMode({ data: { mode } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memory"] }),
	});
	const clear = useMutation({
		mutationFn: () => clearMemory(),
		onSuccess: () => {
			setConfirmClear(false);
			setSelected(RECENT);
			return queryClient.invalidateQueries({ queryKey: ["memory"] });
		},
	});
	const undo = useMutation({
		mutationFn: (row: MemoryRow) =>
			undoLine({ data: { path: row.path, text: row.text } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memory"] }),
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
	const topics = useMemo(() => memoryTopics(repo, date), [repo, date]);

	if (memory.isPending)
		return (
			<section className="memory-inspector memory-muted">
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
	const topic = topics.find((row) => row.id === selected);
	const view = query.trim()
		? "search"
		: selected === RECENT || !topic
			? "recent"
			: "topic";
	const shown =
		view === "search"
			? searchMemoryRows(rows, query)
			: view === "recent"
				? recentMemoryRows(rows)
				: topicRows(rows, selected);
	const openTopic = (id: string) => {
		setSelected(id);
		setQuery("");
	};
	const rowList = (showTopic: boolean) => (
		<MemoryRowList
			rows={shown}
			showTopic={showTopic}
			topics={repo}
			onOpenTopic={openTopic}
			onOpenChat={onOpenChat}
			onUndo={(row) => undo.mutate(row)}
			undoing={undo.isPending ? undo.variables : undefined}
		/>
	);
	return (
		<section
			className="memory-inspector"
			data-layout={layout}
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
				<div className="memory-actions">
					<button
						type="button"
						disabled={toggle.isPending}
						aria-pressed={on}
						onClick={() => toggle.mutate(on ? "off" : "full")}
					>
						{on ? "Memory on" : "Memory off"}
					</button>
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
							aria-label="Clear memory"
							disabled={!files?.length}
							onClick={() => setConfirmClear(true)}
						>
							<Trash2 size={14} /> Clear
						</button>
					)}
				</div>
			</div>
			{!files?.length ? (
				<div className="inspector-empty">
					<h2>No memory yet.</h2>
					<p>
						The agent saves your preferences, decisions and corrections here as
						you chat, so later chats don't need them repeated.
					</p>
				</div>
			) : (
				<div className="memory-body">
					<nav className="memory-topics" aria-label="Memory topics">
						<button
							type="button"
							className="memory-topic"
							aria-pressed={view === "recent"}
							onClick={() => openTopic(RECENT)}
						>
							<Clock3 size={13} aria-hidden="true" />
							<span className="memory-topic-title">Recently added</span>
						</button>
						{topics.map((row) => (
							<button
								key={row.id}
								type="button"
								className="memory-topic"
								data-pinned={row.id === RULES_TOPIC ? "true" : undefined}
								aria-pressed={view === "topic" && selected === row.id}
								onClick={() => openTopic(row.id)}
							>
								{row.id === RULES_TOPIC ? (
									<Pin size={13} aria-hidden="true" />
								) : (
									<span className="memory-topic-dot" aria-hidden="true" />
								)}
								<span className="memory-topic-title">{row.title}</span>
								<span className="memory-topic-meta">
									{row.count}
									{row.updated ? ` · ${formatDate(row.updated)}` : ""}
								</span>
							</button>
						))}
					</nav>
					<div className="memory-panel">
						{view === "topic" && topic ? (
							<TopicView
								key={topic.id}
								title={topic.title}
								path={topic.id === RULES_TOPIC ? null : topic.id}
								content={repo[topic.id] ?? ""}
							>
								{rowList(topic.id === RULES_TOPIC)}
							</TopicView>
						) : (
							<>
								<header>
									<h3>
										{view === "search"
											? `${shown.length} ${shown.length === 1 ? "match" : "matches"}`
											: "Recently added"}
									</h3>
								</header>
								{shown.length ? (
									rowList(true)
								) : (
									<p className="memory-muted">
										{view === "search"
											? "No memory line matches."
											: "No dated lines yet."}
									</p>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

/** A topic's title, its rows, and its file's history on request. */
function TopicView({
	title,
	path,
	content,
	children,
}: {
	title: string;
	/** The topic's file; null for the project rules across files. */
	path: string | null;
	content: string;
	children: ReactNode;
}) {
	const [showHistory, setShowHistory] = useState(false);
	const readHistory = useServerFn(readMemoryHistoryFn);
	const history = useQuery({
		queryKey: ["memory-history", path, content],
		queryFn: () => readHistory({ data: { path: path ?? MEMORY_ENTRY } }),
		enabled: showHistory && Boolean(path),
	});
	return (
		<>
			<header>
				<h3>
					{title}
					{path ? <span className="memory-muted"> {path}</span> : null}
				</h3>
				{path ? (
					<button
						type="button"
						aria-pressed={showHistory}
						onClick={() => setShowHistory((value) => !value)}
					>
						<History size={14} /> History
					</button>
				) : null}
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
		</>
	);
}

/** Memory lines as rows: text with badges, then kind, topic, date and source muted, with small actions. */
export function MemoryRowList({
	rows,
	showTopic,
	topics,
	onOpenTopic,
	onOpenChat,
	onUndo,
	undoing,
}: {
	rows: readonly MemoryRow[];
	/** Rows from several topics (feed, search, rules) name their topic. */
	showTopic: boolean;
	topics: Readonly<Record<string, string>>;
	onOpenTopic: (path: string) => void;
	onOpenChat: (chatId: string) => boolean;
	onUndo?: (row: MemoryRow) => void;
	undoing?: MemoryRow;
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
	return (
		<ul className="memory-rows">
			{rows.map((row) => (
				<li
					key={`${row.path}:${row.line}`}
					className="memory-row"
					data-replaced={row.replaced ? "true" : undefined}
				>
					<p className="memory-row-text">
						{row.rule ? <span className="memory-badge">Rule</span> : null}
						{row.replaced ? (
							<span className="memory-badge" data-tone="replaced">
								Replaced
							</span>
						) : null}
						<span>{inline(row.text)}</span>
					</p>
					<p className="memory-row-meta">
						<span>{row.kind}</span>
						{showTopic ? (
							<button
								type="button"
								className="memory-row-action"
								onClick={() => onOpenTopic(row.path)}
							>
								{row.path.replace(/\.md$/, "")}
							</button>
						) : null}
						{row.project ? <span>{row.project}</span> : null}
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
						{onUndo && !row.replaced ? (
							<button
								type="button"
								className="memory-row-action"
								disabled={undoing === row}
								title="Remove this line from memory"
								onClick={() => onUndo(row)}
							>
								{undoing === row ? "Undoing…" : "Undo"}
							</button>
						) : null}
					</p>
				</li>
			))}
		</ul>
	);
}
