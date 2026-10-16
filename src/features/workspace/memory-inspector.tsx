import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { History, Network, Rows3, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { memoryGraph } from "#/domain/memory-graph";
import {
	chatIdFromSource,
	MEMORY_ENTRY,
	memoryLinks,
	parseMemoryLine,
} from "#/domain/memory-repo";
import {
	clearMemoryFn,
	readMemoryFn,
	readMemoryHistoryFn,
	saveMemoryModeFn,
} from "./memory.fn";
import "./memory-inspector.css";

const WIDTH = 600;
const HEIGHT = 420;

/** The user's memory repo: a read-only graph of files and links, each file's entries and history. */
export function MemoryInspector({
	active,
	focus,
	onOpenChat,
}: {
	active: boolean;
	/** A file a chat's memory marker opened; each new request selects it again. */
	focus?: { path: string };
	onOpenChat: (chatId: string) => boolean;
}) {
	const readMemory = useServerFn(readMemoryFn);
	const saveMode = useServerFn(saveMemoryModeFn);
	const clearMemory = useServerFn(clearMemoryFn);
	const queryClient = useQueryClient();
	const memory = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: active,
	});
	const [view, setView] = useState<"graph" | "files">("graph");
	const [selected, setSelected] = useState<string>(focus?.path ?? MEMORY_ENTRY);
	useEffect(() => {
		if (focus) setSelected(focus.path);
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
			setSelected(MEMORY_ENTRY);
			return queryClient.invalidateQueries({ queryKey: ["memory"] });
		},
	});
	const files = memory.data?.files ?? [];
	const graph = useMemo(
		() => memoryGraph(files, { width: WIDTH, height: HEIGHT }),
		[files],
	);
	const file = files.find((row) => row.path === selected) ?? files[0];

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
	return (
		<section className="memory-inspector" aria-label="Memory">
			<div className="memory-toolbar">
				<div className="memory-views">
					<button
						type="button"
						aria-pressed={view === "graph"}
						onClick={() => setView("graph")}
					>
						<Network size={14} /> Graph
					</button>
					<button
						type="button"
						aria-pressed={view === "files"}
						onClick={() => setView("files")}
					>
						<Rows3 size={14} /> Files
					</button>
				</div>
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
							disabled={!files.length}
							onClick={() => setConfirmClear(true)}
						>
							<Trash2 size={14} /> Clear
						</button>
					)}
				</div>
			</div>
			{!files.length ? (
				<div className="inspector-empty">
					<h2>No memory yet.</h2>
					<p>
						The agent saves your preferences, decisions and corrections here as
						you chat, so later chats don't need them repeated.
					</p>
				</div>
			) : (
				<div className="memory-body">
					{view === "graph" ? (
						<svg
							className="memory-graph"
							viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
							role="img"
							aria-label="Memory files and their links"
						>
							{graph.edges.map((edge) => {
								const from = graph.nodes.find(
									(node) => node.path === edge.from,
								);
								const to = graph.nodes.find((node) => node.path === edge.to);
								return from && to ? (
									<line
										key={`${edge.from}->${edge.to}`}
										x1={from.x}
										y1={from.y}
										x2={to.x}
										y2={to.y}
										data-active={
											file?.path === edge.from || file?.path === edge.to
										}
									/>
								) : null;
							})}
							{graph.nodes.map((node) => (
								// biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>.
								<g
									key={node.path}
									role="button"
									tabIndex={0}
									aria-label={node.path}
									data-root={node.root}
									data-active={file?.path === node.path}
									transform={`translate(${node.x} ${node.y})`}
									onClick={() => setSelected(node.path)}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ")
											setSelected(node.path);
									}}
								>
									<circle
										r={node.root ? 11 : 5 + Math.min(node.backlinks.length, 5)}
									/>
									<text y={node.root ? 26 : 20}>
										{node.path.replace(/\.md$/, "")}
									</text>
								</g>
							))}
						</svg>
					) : (
						<ul className="memory-files">
							{files.map((row) => (
								<li key={row.path}>
									<button
										type="button"
										aria-pressed={file?.path === row.path}
										onClick={() => setSelected(row.path)}
									>
										<span>{row.path}</span>
										<span className="memory-muted">
											{row.content.split("\n").length} lines
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{file ? (
						<MemoryFilePanel
							key={file.path}
							path={file.path}
							content={file.content}
							backlinks={
								graph.nodes.find((node) => node.path === file.path)
									?.backlinks ?? []
							}
							onOpenFile={setSelected}
							onOpenChat={onOpenChat}
							exists={(path) => files.some((row) => row.path === path)}
						/>
					) : null}
				</div>
			)}
		</section>
	);
}

function MemoryFilePanel({
	path,
	content,
	backlinks,
	onOpenFile,
	onOpenChat,
	exists,
}: {
	path: string;
	content: string;
	backlinks: string[];
	onOpenFile: (path: string) => void;
	onOpenChat: (chatId: string) => boolean;
	exists: (path: string) => boolean;
}) {
	const [showHistory, setShowHistory] = useState(false);
	const readHistory = useServerFn(readMemoryHistoryFn);
	const history = useQuery({
		queryKey: ["memory-history", path, content],
		queryFn: () => readHistory({ data: { path } }),
		enabled: showHistory,
	});
	const inline = (text: string) =>
		text.split(/(\[\[[^\]]+\]\])/g).map((part, index) => {
			const target = /^\[\[([^\]]+)\]\]$/.exec(part)?.[1];
			if (!target) return part;
			const resolved = memoryLinks(part)[0];
			return exists(resolved) ? (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed line.
					key={index}
					type="button"
					className="memory-link"
					onClick={() => onOpenFile(resolved)}
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
		<article className="memory-panel" aria-label={path}>
			<header>
				<h3>{path}</h3>
				<button
					type="button"
					aria-pressed={showHistory}
					onClick={() => setShowHistory((value) => !value)}
				>
					<History size={14} /> History
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
				<div className="memory-content">
					{content.split("\n").map((raw, index) => {
						const entry = parseMemoryLine(raw);
						const key = `${index}:${raw}`;
						if (entry) {
							const chat = entry.meta.source
								? chatIdFromSource(entry.meta.source)
								: null;
							return (
								<p key={key} className="memory-entry">
									<span>{inline(entry.text)}</span>
									{entry.meta.kind === "inferred" ? (
										<span
											className="memory-badge"
											title="Derived by the agent, not stated by you"
										>
											inferred
										</span>
									) : null}
									{entry.meta.project ? (
										<span className="memory-badge">{entry.meta.project}</span>
									) : null}
									{entry.meta.expires ? (
										<span className="memory-badge">
											until {entry.meta.expires}
										</span>
									) : null}
									{chat ? (
										<a
											className="memory-source"
											href={`/?chat=${chat}`}
											onClick={(event) => {
												if (onOpenChat(chat)) event.preventDefault();
											}}
										>
											source
										</a>
									) : null}
									{entry.meta.added ? (
										<span className="memory-muted">{entry.meta.added}</span>
									) : null}
								</p>
							);
						}
						const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
						if (heading)
							return (
								<p
									key={key}
									className="memory-heading"
									data-level={heading[1].length}
								>
									{inline(heading[2])}
								</p>
							);
						return raw.trim() ? <p key={key}>{inline(raw)}</p> : null;
					})}
				</div>
			)}
			{backlinks.length ? (
				<footer>
					<span className="memory-muted">Linked from</span>
					{backlinks.map((link) => (
						<button
							key={link}
							type="button"
							className="memory-link"
							onClick={() => onOpenFile(link)}
						>
							{link.replace(/\.md$/, "")}
						</button>
					))}
				</footer>
			) : null}
		</article>
	);
}
