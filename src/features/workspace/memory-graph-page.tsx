import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Calendar,
	ChevronDown,
	FolderInput,
	Hash,
	Maximize2,
	Minus,
	Moon,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MEMORY_EDIT_TEXT_MAX, type MemoryEdit } from "#/domain/memory-edit";
import {
	axisStep,
	dayDate,
	type LaneNode,
	laneColor,
	memoryLanes,
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
const DAY = 86_400_000;
/** Pixels: the label column, the space above the first lane and below the last. */
const TOP = 76;
const AXIS = 34;
const SLOT = 13;
/** Readable whatever the zoom: marks are sized in pixels, not in days. */
const R = 4.5;
const R_NEW = 5.5;

type View = { pxPerDay: number; offset: number };

function shortDate(day: number) {
	return new Date(day * DAY).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** One line's mark: solid (stated), hollow (inferred) or a diamond (always on). */
export function LaneMark({
	mark,
	color,
	recent,
	x = 0,
	y = 0,
}: {
	mark: LaneNode["mark"];
	color: string;
	recent?: boolean;
	x?: number;
	y?: number;
}) {
	const r = recent ? R_NEW : R;
	return (
		<g className="lane-mark" data-mark={mark} style={{ color }}>
			{recent ? <circle className="lane-glow" cx={x} cy={y} r={r + 5} /> : null}
			{mark === "rule" ? (
				<path
					className="lane-shape"
					d={`M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`}
				/>
			) : (
				<circle
					className="lane-shape"
					cx={x}
					cy={y}
					r={mark === "inferred" ? r - 0.75 : r}
				/>
			)}
		</g>
	);
}

/** A dream's merge: a ring with a plus, like a merge commit. */
export function MergeMark({ x = 0, y = 0 }: { x?: number; y?: number }) {
	return (
		<g className="lane-merge">
			<circle cx={x} cy={y} r={6.5} />
			<path d={`M${x - 3} ${y}H${x + 3}M${x} ${y - 3}V${y + 3}`} />
		</g>
	);
}

/**
 * Memory lanes: the memory repo as its history. One lane per scope, time
 * left to right with today at the right; lines as marks at their dates,
 * version changes as curves, dreams as markers across the lanes with their
 * merges. Drag to pan, scroll or pinch to zoom time; click a mark for its
 * details and edits, a lane label to show only that scope.
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
	const history = useQuery({
		queryKey: ["memory-lanes", memory.data?.files],
		queryFn: () => readGraph(),
		enabled: active && Boolean(memory.data?.available),
		staleTime: 60_000,
	});
	const [scope, setScope] = useState<string>(ALL);
	const [selected, setSelected] = useState<string | null>(null);
	const [hovered, setHovered] = useState<{
		id: string;
		left: number;
		top: number;
	} | null>(null);
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
	const lanes = useMemo(
		() =>
			memoryLanes({
				rows,
				today: date,
				scope: scope === ALL ? null : scope,
				dreams: history.data?.dreams,
			}),
		[rows, date, scope, history.data],
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
	const laneColors = lanes.lanes.map((lane) => colorOf(lane.project));
	const laneHeights = lanes.lanes.map((lane) =>
		Math.min(150, 56 + (lane.depth - 1) * SLOT),
	);
	const laneTop = laneHeights.map((_, index) =>
		laneHeights.slice(0, index).reduce((sum, height) => sum + height, TOP),
	);
	const lanesBottom =
		TOP + laneHeights.reduce((sum, height) => sum + height, 0);

	const frame = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(1200);
	const narrow = width < 640;
	const labelWidth = narrow ? 96 : 168;
	const [view, setView] = useState<View>({ pxPerDay: 24, offset: 0 });
	const fitView = useCallback(() => {
		const element = frame.current;
		const span = Math.max(1, lanes.end - lanes.start);
		const available = (element?.clientWidth ?? 1200) - (narrow ? 96 : 168) - 40;
		const pxPerDay = Math.max(narrow ? 10 : 4, Math.min(120, available / span));
		// When the history is wider than the screen, start at today (the right end).
		setView({ pxPerDay, offset: Math.min(0, available - span * pxPerDay) });
	}, [lanes.end, lanes.start, narrow]);
	useEffect(() => {
		const element = frame.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) =>
			setWidth(Math.round(entry.contentRect.width)),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const fittedFor = useRef("");
	useEffect(() => {
		const id = `${lanes.start}:${lanes.end}:${width}`;
		if (fittedFor.current !== id && width) {
			fittedFor.current = id;
			fitView();
		}
	}, [lanes.start, lanes.end, width, fitView]);
	const x = (day: number) =>
		labelWidth + 16 + (day - lanes.start) * view.pxPerDay + view.offset;
	const laneY = (lane: number) => laneTop[lane] + laneHeights[lane] / 2;
	const nodeAt = new Map(
		lanes.nodes.map((node) => [
			node.id,
			{ node, x: x(node.day), y: laneY(node.lane) + node.slot * SLOT },
		]),
	);

	// Wheel: zoom time around the cursor (pinch arrives as ctrl+wheel); sideways scroll pans.
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			const px = event.clientX - rect.left;
			setView((current) => {
				if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey)
					return { ...current, offset: current.offset - event.deltaX };
				const pxPerDay = Math.max(
					2,
					Math.min(160, current.pxPerDay * Math.exp(-event.deltaY * 0.002)),
				);
				const origin = labelWidth + 16;
				const day = (px - origin - current.offset) / current.pxPerDay;
				return { pxPerDay, offset: px - origin - day * pxPerDay };
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [labelWidth]);

	const drag = useRef<{
		startX: number;
		offset: number;
		moved: boolean;
	} | null>(null);
	const markAt = (target: EventTarget | null) =>
		(target as Element | null)
			?.closest?.("[data-node]")
			?.getAttribute("data-node") ?? null;
	const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startX: event.clientX, offset: view.offset, moved: false };
	};
	const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
		const current = drag.current;
		if (current) {
			const dx = event.clientX - current.startX;
			if (Math.abs(dx) > 3) current.moved = true;
			if (current.moved) {
				setHovered(null);
				setView((value) => ({ ...value, offset: current.offset + dx }));
			}
			return;
		}
		const id = markAt(event.target);
		const rect = frame.current?.getBoundingClientRect();
		if (id && rect)
			setHovered({
				id,
				left: event.clientX - rect.left,
				top: event.clientY - rect.top,
			});
		else if (hovered) setHovered(null);
	};
	const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
		const current = drag.current;
		drag.current = null;
		if (!current || current.moved) return;
		const id = markAt(event.target);
		setHovered(null);
		setSelected(id && id !== selected ? id : null);
	};

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
	const focus = hovered?.id ?? selected;
	const focusChain = new Set(
		focus ? (nodeAt.get(focus)?.node.chain ?? []) : [],
	);
	const total = lanes.nodes.filter((node) => !node.retired).length;
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
	const step = axisStep(view.pxPerDay);
	const ticks: number[] = [];
	const firstTick = Math.ceil(lanes.start / step) * step;
	for (let day = firstTick; day <= lanes.end; day += step) ticks.push(day);
	const svgHeight = lanesBottom + AXIS;
	const hoveredNode = hovered ? nodeAt.get(hovered.id)?.node : undefined;
	const selectedNode = selected ? nodeAt.get(selected)?.node : undefined;
	const dreamX = (at: string) => x(Date.parse(at) / DAY);
	return (
		<section
			className="memory-graph-page memory-lanes"
			aria-label="Memory lanes"
			data-narrow={narrow ? "true" : undefined}
		>
			<div ref={frame} className="memory-lanes-frame">
				<svg
					className="memory-lanes-svg"
					role="img"
					aria-label={`Memory lanes: ${total} memories in ${lanes.lanes.length} ${lanes.lanes.length === 1 ? "scope" : "scopes"}`}
					height={svgHeight}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={() => {
						drag.current = null;
					}}
					onPointerLeave={() => setHovered(null)}
					onKeyDown={(event) => {
						if (event.key === "Escape") setSelected(null);
					}}
				>
					<g className="lane-rules">
						{lanes.lanes.map((lane, index) => (
							<g key={lane.id}>
								<line
									x1={labelWidth}
									x2="100%"
									y1={laneY(index)}
									y2={laneY(index)}
								/>
								{index ? (
									<line
										className="lane-divider"
										x1={0}
										x2="100%"
										y1={laneTop[index]}
										y2={laneTop[index]}
									/>
								) : null}
							</g>
						))}
					</g>
					<g className="lane-axis">
						<line
							x1={labelWidth}
							x2="100%"
							y1={lanesBottom + 4}
							y2={lanesBottom + 4}
						/>
						{ticks.map((day) =>
							x(day) > labelWidth + 8 ? (
								<text key={day} x={x(day)} y={lanesBottom + 22}>
									{shortDate(day)}
								</text>
							) : null,
						)}
					</g>
					<g className="lane-today">
						<line
							x1={x(lanes.today)}
							x2={x(lanes.today)}
							y1={TOP - 8}
							y2={lanesBottom + 4}
						/>
						<text x={x(lanes.today)} y={TOP - 14}>
							Today
						</text>
					</g>
					<g className="lane-dreams">
						{lanes.dreams.map((dream) => {
							const dx = dreamX(dream.at);
							return (
								<g key={dream.id} className="lane-dream">
									<line x1={dx} x2={dx} y1={TOP - 4} y2={lanesBottom} />
									<Moon
										x={dx - 6}
										y={TOP - 26}
										width={12}
										height={12}
										strokeWidth={1.8}
									/>
									<title>{`Dream, ${shortDate(dream.day)}: ${dream.message}`}</title>
									{dream.merges.map((merge) => {
										const my = laneY(merge.lane);
										const target = merge.into ? nodeAt.get(merge.into) : null;
										return (
											<g key={`${dream.id}:${merge.text}`}>
												{merge.ghosts.map((ghost) => {
													const gx = x(ghost.day);
													const gy = laneY(ghost.lane) + SLOT;
													return (
														<g key={ghost.text} className="lane-ghost">
															<path
																className="lane-merge-line"
																d={`M${gx} ${gy}C${(gx + dx) / 2} ${gy} ${(gx + dx) / 2} ${my} ${dx - 7} ${my}`}
															/>
															<LaneMark
																mark={ghost.mark}
																color={laneColors[ghost.lane]}
																x={gx}
																y={gy}
															/>
															<title>{`Merged: ${ghost.text}`}</title>
														</g>
													);
												})}
												{target ? (
													<path
														className="lane-merge-line"
														data-into="true"
														d={`M${dx + 7} ${my}C${(dx + target.x) / 2} ${my} ${(dx + target.x) / 2} ${target.y} ${target.x} ${target.y}`}
													/>
												) : null}
												<MergeMark x={dx} y={my} />
											</g>
										);
									})}
								</g>
							);
						})}
					</g>
					<g className="lane-curves" data-focus={focus ? "true" : undefined}>
						{lanes.curves.map((curve) => {
							const a = nodeAt.get(curve.from);
							const b = nodeAt.get(curve.to);
							if (!a || !b) return null;
							const mid = (a.x + b.x) / 2;
							return (
								<path
									key={curve.id}
									data-active={
										focusChain.has(curve.from) && focusChain.has(curve.to)
											? "true"
											: undefined
									}
									d={`M${a.x} ${a.y}C${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`}
								/>
							);
						})}
					</g>
					<g className="lane-nodes" data-focus={focus ? "true" : undefined}>
						{lanes.nodes.map((node) => {
							const at = nodeAt.get(node.id);
							if (!at || at.x < labelWidth - 4) return null;
							return (
								<g
									key={node.id}
									data-node={node.id}
									data-retired={node.retired ? "true" : undefined}
									data-chain={focusChain.has(node.id) ? "true" : undefined}
									data-selected={selected === node.id ? "true" : undefined}
								>
									<circle className="lane-hit" cx={at.x} cy={at.y} r={10} />
									{selected === node.id || hovered?.id === node.id ? (
										<circle
											className="lane-ring"
											cx={at.x}
											cy={at.y}
											r={(node.recent ? R_NEW : R) + 4}
										/>
									) : null}
									<LaneMark
										mark={node.mark}
										color={laneColors[node.lane]}
										recent={node.recent}
										x={at.x}
										y={at.y}
									/>
								</g>
							);
						})}
					</g>
				</svg>
				<ul className="lane-labels" style={{ width: labelWidth }}>
					{lanes.lanes.map((lane, index) => (
						<li
							key={lane.id}
							style={{ top: laneTop[index], height: laneHeights[index] }}
						>
							<button
								type="button"
								aria-pressed={scope === lane.id}
								title={
									scope === lane.id ? "Show all" : `Only ${scopeTitle(lane.id)}`
								}
								onClick={() => {
									setScope(scope === lane.id ? ALL : lane.id);
									setSelected(null);
								}}
							>
								<i style={{ background: laneColors[index] }} />
								<span>{scopeTitle(lane.id)}</span>
								<small>{lane.count}</small>
							</button>
						</li>
					))}
				</ul>
				{hoveredNode && hovered ? (
					<div
						className="memory-graph-tip"
						role="tooltip"
						style={{ left: hovered.left, top: hovered.top }}
						data-flip={hovered.left > width * 0.6 ? "true" : undefined}
					>
						<p>{hoveredNode.row.text}</p>
						<span>
							{hoveredNode.undated
								? "undated"
								: formatMemoryDate(dayDate(hoveredNode.day))}
							{hoveredNode.versions > 1
								? ` · v${hoveredNode.version} of ${hoveredNode.versions}`
								: ""}
						</span>
					</div>
				) : null}
			</div>

			<MemoryScopeMenu
				label="Show"
				choices={scopeChoices}
				value={scope}
				onChoose={(value) => {
					setScope(value ?? ALL);
					setSelected(null);
				}}
			>
				<button type="button" className="memory-graph-card memory-graph-scope">
					<span>
						<strong>{scope === ALL ? "All memory" : scopeTitle(scope)}</strong>
						<small>
							{total} {total === 1 ? "memory" : "memories"}
						</small>
					</span>
					<ChevronDown size={14} aria-hidden="true" />
				</button>
			</MemoryScopeMenu>

			<div className="memory-graph-card memory-lanes-zoom">
				<button
					type="button"
					aria-label="Zoom out"
					onClick={() =>
						setView((current) => ({
							...current,
							pxPerDay: Math.max(2, current.pxPerDay / 1.4),
						}))
					}
				>
					<Minus size={14} />
				</button>
				<button
					type="button"
					aria-label="Zoom in"
					onClick={() =>
						setView((current) => ({
							...current,
							pxPerDay: Math.min(160, current.pxPerDay * 1.4),
						}))
					}
				>
					<Plus size={14} />
				</button>
				<button type="button" onClick={fitView}>
					<Maximize2 size={13} aria-hidden="true" /> Fit
				</button>
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

			<MemoryLanesLegend />
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
					<X size={14} />
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
				{row.added ? (
					<span>
						<Calendar size={12} aria-hidden="true" />
						{formatMemoryDate(row.added)}
					</span>
				) : null}
				<span>
					<Hash size={12} aria-hidden="true" />
					{row.path.replace(/\.md$/, "")}
				</span>
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
								<Pencil size={13} aria-hidden="true" /> Edit
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
									<FolderInput size={13} aria-hidden="true" /> Move
								</button>
							</MemoryScopeMenu>
							<button
								type="button"
								disabled={busy}
								aria-pressed={row.rule}
								onClick={() => onEdit({ op: "update", ref, always: !row.rule })}
							>
								{row.rule ? (
									<PinOff size={13} aria-hidden="true" />
								) : (
									<Pin size={13} aria-hidden="true" />
								)}
								{row.rule ? "Unpin" : "Pin"}
							</button>
						</>
					)}
					<button
						type="button"
						aria-label="Delete"
						disabled={busy}
						onClick={() => setConfirmDelete(true)}
					>
						<Trash2 size={13} aria-hidden="true" />
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

/** One row: every mark and line the lanes use, drawn the same way. */
export function MemoryLanesLegend() {
	const item = (mark: ReactNode, label: string, width = 18) => (
		<li>
			<svg
				viewBox={`${-width / 2} -9 ${width} 18`}
				width={width}
				height={18}
				aria-hidden="true"
			>
				{mark}
			</svg>
			{label}
		</li>
	);
	const grey = "#a3a3a3";
	return (
		<ul className="memory-lanes-legend" aria-label="Legend">
			{item(<LaneMark mark="stated" color={grey} />, "Stated")}
			{item(<LaneMark mark="inferred" color={grey} />, "Inferred")}
			{item(<LaneMark mark="rule" color={grey} />, "Always on")}
			{item(<LaneMark mark="stated" color={grey} recent />, "New", 22)}
			{item(
				<g opacity={0.3}>
					<LaneMark mark="stated" color={grey} />
				</g>,
				"Replaced",
			)}
			{item(
				<g className="lane-curves">
					<path data-active="true" d="M-12 5C-2 5 2 -5 12 -5" />
				</g>,
				"Changed",
				26,
			)}
			{item(
				<g className="lane-dream">
					<line x1={-8} x2={-8} y1={-9} y2={9} />
					<MergeMark x={4} y={0} />
				</g>,
				"Dream",
				26,
			)}
		</ul>
	);
}
