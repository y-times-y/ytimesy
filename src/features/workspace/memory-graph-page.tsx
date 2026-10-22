import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MEMORY_EDIT_TEXT_MAX, type MemoryEdit } from "#/domain/memory-edit";
import {
	type HistoryItem,
	type HistoryLink,
	type LaneDream,
	type LaneNode,
	laneColor,
	memoryHistory,
} from "#/domain/memory-lanes";
import { type MemoryRow, memoryRows } from "#/domain/memory-overview";
import type { Project } from "#/domain/projects";
import { editMemoryFn, readMemoryFn, readMemoryGraphFn } from "./memory.fn";
import {
	formatMemoryDate,
	memoryLineRef,
	useMemoryScopeNames,
} from "./memory-inspector";
import { MemoryScopeMenu } from "./memory-menu";
import "./memory-inspector.css";

const today = () => new Date().toISOString().slice(0, 10);
const ALL = "__all";
/** Pixels: a memory row, a dream row, and where a row's dot sits. */
const ROW = 36;
const DREAM_ROW = 32;
const DOT_Y = ROW / 2;

function shortDate(value: string) {
	return new Date(value).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** "1 added, 1 merged, 1 replaced", or the dream's message when it has no counts. */
export function dreamSummary(dream: LaneDream) {
	const counts = dream.counts;
	const merged = dream.merges.reduce(
		(sum, merge) => sum + merge.ghosts.length,
		0,
	);
	const parts = counts
		? [
				[counts.added, "added"],
				[counts.merged, "merged"],
				[counts.replaced, "replaced"],
				[counts.expired, "expired"],
				[counts.removed, "removed"],
			]
		: [[merged, "merged"]];
	const text = parts
		.filter(([count]) => Number(count) > 0)
		.map(([count, label]) => `${count} ${label}`)
		.join(", ");
	return text || dream.message;
}

type Geometry = readonly { readonly top: number; readonly height: number }[];

/** Row tops and heights before the rows are measured: every row at its minimum height. */
function estimate(items: readonly HistoryItem[]): Geometry {
	let top = 0;
	return items.map((item) => {
		const height = item.kind === "dream" ? DREAM_ROW : ROW;
		const row = { top, height };
		top += height;
		return row;
	});
}

/**
 * Memory as a commit list (git log --graph): one row per memory, newest at
 * the top, its text on the row and quiet meta on the right. A narrow gutter
 * holds one thin lane per scope; a row's dot sits on its scope's lane. A
 * replaced row joins its replacement with a short curve; a dream is a divider
 * row, the lines it merged branching in just below it. Click a row for its
 * details and edits; hover shows its version chain.
 */
export function MemoryGraphPage({
	active,
	onOpenChat,
	projects,
}: {
	active: boolean;
	onOpenChat: (chatId: string) => boolean;
	projects?: readonly Pick<Project, "id" | "fullName" | "name">[];
}) {
	const readMemory = useServerFn(readMemoryFn);
	const readGraph = useServerFn(readMemoryGraphFn);
	const editMemory = useServerFn(editMemoryFn);
	const queryClient = useQueryClient();
	const memory = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: active,
	});
	const dreams = useQuery({
		queryKey: ["memory-lanes", memory.data?.files],
		queryFn: () => readGraph(),
		enabled: active && Boolean(memory.data?.available),
		staleTime: 60_000,
	});
	const [scope, setScope] = useState<string>(ALL);
	const [selected, setSelected] = useState<string | null>(null);
	const [hovered, setHovered] = useState<string | null>(null);
	const repo = useMemo(
		() =>
			Object.fromEntries(
				(memory.data?.files ?? []).map((file) => [file.path, file.content]),
			),
		[memory.data?.files],
	);
	const date = today();
	const rows = useMemo(() => memoryRows(repo, date), [repo, date]);
	const { scopes, scopeTitle, choices } = useMemoryScopeNames(rows, projects);
	const history = useMemo(
		() =>
			memoryHistory({
				rows,
				today: date,
				scope: scope === ALL ? null : scope,
				dreams: dreams.data?.dreams,
			}),
		[rows, date, scope, dreams.data],
	);
	const cachedProjects =
		projects ?? queryClient.getQueryData<Project[]>(["projects"]);
	const colorOf = (project: string | null) => {
		if (!project) return laneColor(null);
		const known = cachedProjects?.find(
			(entry) => entry.fullName.toLowerCase() === project.toLowerCase(),
		);
		return laneColor(known?.id ?? project.toLowerCase());
	};
	const laneColors = history.lanes.map((lane) => colorOf(lane.project));

	// Rows wrap on narrow screens, so the graph follows their measured positions.
	const [listElement, setListElement] = useState<HTMLOListElement | null>(null);
	const [width, setWidth] = useState(1200);
	const [measured, setMeasured] = useState<Geometry | null>(null);
	const geometry =
		measured && measured.length === history.items.length
			? measured
			: estimate(history.items);
	const measure = useRef(() => {});
	measure.current = () => {
		if (!listElement) return;
		const next = [...listElement.children].map((child) => {
			const element = child as HTMLElement;
			return { top: element.offsetTop, height: element.offsetHeight };
		});
		setMeasured((current) =>
			current &&
			current.length === next.length &&
			current.every(
				(row, index) =>
					row.top === next[index].top && row.height === next[index].height,
			)
				? current
				: next,
		);
	};
	useLayoutEffect(() => measure.current());
	useEffect(() => {
		if (!listElement || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => {
			setWidth(Math.round(entry.contentRect.width));
			measure.current();
		});
		observer.observe(listElement);
		return () => observer.disconnect();
	}, [listElement]);
	const narrow = width < 640;

	const edit = useMutation({
		mutationFn: (data: MemoryEdit) => editMemory({ data }),
		onSuccess: (result, data) => {
			if (!result.ok) return;
			if (data.op === "delete") setSelected(null);
			return queryClient.invalidateQueries({ queryKey: ["memory"] });
		},
	});

	if (memory.isPending)
		return (
			<section className="memory-graph-page memory-graph-empty">
				Loading memory…
			</section>
		);
	if (memory.isError || !memory.data?.available)
		return (
			<section className="memory-graph-page memory-graph-empty">
				Memory is unavailable.
			</section>
		);

	const { items, links, lanes } = history;
	const hasMerged = items.some((item) => item.kind === "merged");
	const pad = narrow ? 10 : 14;
	const gap = narrow ? 10 : 14;
	const laneX = (lane: number) => pad + lane * gap;
	const sideX = laneX(lanes.length);
	const gutter = pad * 2 + (lanes.length - 1 + (hasMerged ? 1 : 0)) * gap;
	const dotY = (index: number) =>
		geometry[index].top +
		(items[index].kind === "dream" ? geometry[index].height / 2 : DOT_Y);
	const totalHeight = geometry.length
		? geometry[geometry.length - 1].top + geometry[geometry.length - 1].height
		: 0;

	// Focus: the hovered (or selected) row, its version chain and what it absorbed.
	const nodes = new Map(
		items.flatMap((item) =>
			item.kind === "memory" ? [[item.id, item.node] as const] : [],
		),
	);
	const focus = hovered ?? selected;
	const chain = new Set<string>();
	if (focus) {
		const merged = items.find((item) => item.id === focus);
		const ids =
			merged?.kind === "merged"
				? [merged.id, ...(merged.into ? [merged.into] : [])]
				: (nodes.get(focus)?.chain ?? [focus]);
		for (const id of ids) chain.add(id);
		for (const item of items)
			if (item.kind === "merged" && item.into && chain.has(item.into))
				chain.add(item.id);
	}
	const focusing = chain.size > 1;
	const linkActive = (link: HistoryLink) =>
		focusing && chain.has(items[link.from].id) && chain.has(link.target);

	// Lane lines run from a lane's newest row to its oldest.
	const spans = lanes.map(() => ({ first: -1, last: -1 }));
	items.forEach((item, index) => {
		const lane = item.kind === "memory" ? item.node.lane : null;
		if (lane === null) return;
		if (spans[lane].first < 0) spans[lane].first = index;
		spans[lane].last = index;
	});
	for (const link of links)
		if (link.kind === "replaced") {
			const span = spans[link.fromLane];
			span.first = Math.min(span.first, link.to + 1);
		}

	const total = items.filter(
		(item) => item.kind === "memory" && !item.node.retired,
	).length;
	const scopeChoices = [
		{
			value: ALL,
			label: "All memory",
			hint: String(scopes.reduce((sum, entry) => sum + entry.count, 0)),
		},
		...scopes.map((entry) => ({
			value: entry.id,
			label: scopeTitle(entry.id),
			hint: String(entry.count),
		})),
	];
	const selectedNode = selected ? nodes.get(selected) : undefined;
	const laneTitle = (lane: number) => scopeTitle(lanes[lane]?.id ?? "personal");

	let dreamIndex = -1;
	const branches: { from: number; dream: number; lane: number }[] = [];
	for (const [index, item] of items.entries()) {
		if (item.kind === "dream") dreamIndex = index;
		if (item.kind === "merged" && dreamIndex >= 0) {
			const into = item.into ? nodes.get(item.into) : undefined;
			branches.push({
				from: index,
				dream: dreamIndex,
				lane: into?.lane ?? item.lane,
			});
		}
	}

	return (
		<section
			className="memory-graph-page memory-log-page"
			aria-label="Memory history"
			data-narrow={narrow ? "true" : undefined}
			data-details={selectedNode ? "true" : undefined}
		>
			<header className="memory-log-bar">
				<MemoryScopeMenu
					label="Show"
					choices={scopeChoices}
					value={scope}
					onChoose={(value) => {
						setScope(value ?? ALL);
						setSelected(null);
					}}
				>
					<button type="button" className="memory-log-scope">
						<strong>{scope === ALL ? "All memory" : scopeTitle(scope)}</strong>
						<ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
					</button>
				</MemoryScopeMenu>
				<span className="memory-log-count">
					{total} {total === 1 ? "memory" : "memories"}
				</span>
			</header>

			<div className="memory-log-scroll">
				<div className="memory-log-body">
					<svg
						className="memory-log-graph"
						width={gutter}
						height={totalHeight}
						aria-hidden="true"
						data-focus={focusing ? "true" : undefined}
					>
						{spans.map((span, lane) =>
							span.first < 0 ? null : (
								<line
									key={lanes[lane].id}
									className="history-lane"
									x1={laneX(lane)}
									x2={laneX(lane)}
									y1={dotY(span.first)}
									y2={dotY(span.last)}
									style={{ stroke: laneColors[lane] }}
								/>
							),
						)}
						{links.map((link) => {
							if (link.kind !== "replaced") return null;
							// Up the old row's lane, then a short curve into the new row's dot.
							const ox = laneX(link.fromLane);
							const nx = laneX(link.toLane);
							const step = link.from > link.to ? 1 : -1;
							const oy = dotY(link.from);
							const ny = dotY(link.to);
							const near = Math.abs(link.from - link.to) === 1;
							const sy = near ? oy : dotY(link.to + step);
							const bend = ox === nx ? 9 : 0;
							const curve = `C${ox + bend} ${(sy + ny) / 2} ${nx + bend} ${(sy + ny) / 2} ${nx} ${ny}`;
							return (
								<path
									key={link.id}
									className="history-link"
									data-active={linkActive(link) ? "true" : undefined}
									d={`M${ox} ${oy}L${ox} ${sy}${curve}`}
									style={{ stroke: laneColors[link.fromLane] }}
								/>
							);
						})}
						{branches.map((branch) => {
							const by = dotY(branch.from);
							const dy = dotY(branch.dream);
							const tx = laneX(branch.lane);
							const link = links.find(
								(entry) =>
									entry.kind === "merged" && entry.from === branch.from,
							);
							return (
								<path
									key={`branch:${branch.from}`}
									className="history-link history-branch"
									data-active={link && linkActive(link) ? "true" : undefined}
									d={`M${sideX} ${by}L${sideX} ${dy + 12}C${sideX} ${dy + 4} ${tx} ${dy + 6} ${tx} ${dy}`}
									style={{ stroke: laneColors[branch.lane] }}
								/>
							);
						})}
						{items.map((item, index) => {
							if (item.kind === "dream") return null;
							const y = dotY(index);
							if (item.kind === "merged")
								return (
									<circle
										key={item.id}
										className="history-dot"
										data-retired="true"
										cx={sideX}
										cy={y}
										r={3}
										style={{ color: laneColors[item.lane] }}
									/>
								);
							const node = item.node;
							return (
								<circle
									key={item.id}
									className="history-dot"
									data-recent={node.recent ? "true" : undefined}
									data-retired={node.retired ? "true" : undefined}
									data-chain={
										focusing && chain.has(item.id) ? "true" : undefined
									}
									cx={laneX(node.lane)}
									cy={y}
									r={node.recent ? 4 : 3.5}
									style={{ color: laneColors[node.lane] }}
								/>
							);
						})}
					</svg>
					<ol
						ref={setListElement}
						className="memory-log"
						aria-label={`${total} memories in ${lanes.length} ${lanes.length === 1 ? "scope" : "scopes"}`}
						data-focus={focusing ? "true" : undefined}
						style={{ ["--gutter" as string]: `${gutter}px` }}
						onPointerLeave={() => setHovered(null)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setSelected(null);
						}}
					>
						{items.map((item) => {
							if (item.kind === "dream")
								return (
									<li
										key={item.id}
										className="history-dream"
										title={item.dream.message}
									>
										<span>
											Dream · {shortDate(item.dream.at)} ·{" "}
											{dreamSummary(item.dream)}
										</span>
									</li>
								);
							if (item.kind === "merged")
								return (
									<li
										key={item.id}
										className="history-row"
										data-row={item.id}
										data-kind="merged"
										data-chain={
											focusing && chain.has(item.id) ? "true" : undefined
										}
										onPointerEnter={() => setHovered(item.id)}
									>
										<span className="history-text" title={item.text}>
											{item.text}
										</span>
										<span className="history-meta">
											{item.mark === "inferred" ? <span>Inferred</span> : null}
											<span>Merged</span>
										</span>
									</li>
								);
							const node = item.node;
							const row = node.row;
							return (
								<li
									key={item.id}
									data-row={item.id}
									data-chain={
										focusing && chain.has(item.id) ? "true" : undefined
									}
								>
									<button
										type="button"
										className="history-row"
										data-retired={node.retired ? "true" : undefined}
										aria-pressed={selected === item.id}
										onPointerEnter={() => setHovered(item.id)}
										onFocus={() => setHovered(item.id)}
										onBlur={() => setHovered(null)}
										onClick={() =>
											setSelected(selected === item.id ? null : item.id)
										}
									>
										<span className="history-text" title={row.text}>
											{row.text}
										</span>
										{row.rule ? (
											<span className="history-tag">Always on</span>
										) : null}
										<span className="history-meta">
											{row.kind === "inferred" ? <span>Inferred</span> : null}
											{scope === ALL ? (
												<span className="history-scope">
													{laneTitle(node.lane)}
												</span>
											) : null}
											<span className="history-date">
												{row.added ? shortDate(`${row.added}T00:00:00Z`) : ""}
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				</div>
			</div>

			{selectedNode ? (
				<MemoryDetails
					key={selectedNode.id}
					node={selectedNode}
					scopeLabel={scopeTitle(
						selectedNode.row.project?.trim()
							? `project:${selectedNode.row.project.trim().toLowerCase()}`
							: "personal",
					)}
					choices={choices}
					busy={edit.isPending}
					error={
						edit.data && !edit.data.ok ? edit.data.error : edit.error?.message
					}
					onClose={() => setSelected(null)}
					onOpenChat={onOpenChat}
					onEdit={(data) => edit.mutate(data)}
				/>
			) : null}
		</section>
	);
}

/** The selected line: its text, where it applies, its version, and the list's edits. */
function MemoryDetails({
	node,
	scopeLabel,
	choices,
	busy,
	error,
	onClose,
	onOpenChat,
	onEdit,
}: {
	node: LaneNode;
	scopeLabel: string;
	choices: ReturnType<typeof useMemoryScopeNames>["choices"];
	busy: boolean;
	error?: string;
	onClose: () => void;
	onOpenChat: (chatId: string) => boolean;
	onEdit: (edit: MemoryEdit) => void;
}) {
	const row: MemoryRow = node.row;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(row.text);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ref = memoryLineRef(row);
	const status = node.retired
		? "replaced"
		: row.expires
			? `until ${row.expires}`
			: node.recent
				? "new"
				: null;
	return (
		<aside className="memory-graph-card memory-graph-details">
			<header>
				<h2>Memory</h2>
				<button type="button" aria-label="Close" onClick={onClose}>
					<X size={16} strokeWidth={1.5} />
				</button>
			</header>
			<dl>
				<div>
					<dt>Memory</dt>
					<dd>
						{editing ? (
							<textarea
								aria-label="Memory text"
								maxLength={MEMORY_EDIT_TEXT_MAX}
								value={draft}
								// biome-ignore lint/a11y/noAutofocus: the user just asked to edit.
								autoFocus
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") setEditing(false);
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										if (draft.trim() && draft.trim() !== row.text)
											onEdit({ op: "update", ref, text: draft });
										setEditing(false);
									}
								}}
							/>
						) : (
							<p className="memory-graph-text">{row.text}</p>
						)}
					</dd>
				</div>
				<div>
					<dt>Space</dt>
					<dd>{scopeLabel}</dd>
				</div>
				<div>
					<dt>Version</dt>
					<dd>
						v{node.version}
						{node.versions > 1 ? ` of ${node.versions}` : ""}
						{status ? <span className="memory-muted"> · {status}</span> : null}
					</dd>
				</div>
				<div>
					<dt>Kind</dt>
					<dd>
						{row.kind === "inferred" ? "Inferred" : "Stated"}
						{row.rule ? (
							<span className="memory-muted"> · always on</span>
						) : null}
					</dd>
				</div>
			</dl>
			<p className="memory-graph-foot">
				{row.added ? <span>{formatMemoryDate(row.added)}</span> : null}
				<span>{row.path.replace(/\.md$/, "")}</span>
				{row.chatId ? (
					<a
						href={`/?chat=${row.chatId}`}
						onClick={(event) => {
							if (row.chatId && onOpenChat(row.chatId)) event.preventDefault();
						}}
					>
						Open chat
					</a>
				) : null}
			</p>
			{confirmDelete ? (
				<div className="memory-graph-actions">
					<span>Delete?</span>
					<button
						type="button"
						className="memory-danger"
						disabled={busy}
						onClick={() => onEdit({ op: "delete", ref })}
					>
						Delete
					</button>
					<button type="button" onClick={() => setConfirmDelete(false)}>
						Cancel
					</button>
				</div>
			) : (
				<div className="memory-graph-actions">
					{row.replaced ? null : (
						<>
							<button
								type="button"
								disabled={busy}
								onClick={() => {
									setDraft(row.text);
									setEditing(true);
								}}
							>
								Edit
							</button>
							<MemoryScopeMenu
								label="Move to"
								choices={choices}
								value={row.project ?? null}
								onChoose={(project) => {
									if ((project ?? "") !== (row.project ?? ""))
										onEdit({ op: "update", ref, project });
								}}
							>
								<button type="button" disabled={busy}>
									Move
								</button>
							</MemoryScopeMenu>
							<button
								type="button"
								disabled={busy}
								aria-pressed={row.rule}
								onClick={() => onEdit({ op: "update", ref, always: !row.rule })}
							>
								{row.rule ? "Turn off always on" : "Make always on"}
							</button>
						</>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() => setConfirmDelete(true)}
					>
						Delete
					</button>
				</div>
			)}
			{error ? (
				<p className="memory-composer-error" role="alert">
					{error}
				</p>
			) : null}
		</aside>
	);
}
