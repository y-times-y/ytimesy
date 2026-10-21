import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Archive,
	Calendar,
	ChevronDown,
	Eye,
	FolderInput,
	Hash,
	Maximize2,
	MessageSquare,
	Minus,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Trash2,
	User,
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
	type GraphEdge,
	type GraphHub,
	type GraphMemory,
	layoutBounds,
	MANUAL_HUB,
	memoryGraphModel,
	type SimNode,
	settleLayout,
	stepLayout,
	UNKNOWN_HUB,
} from "#/domain/memory-graph";
import { memoryRows } from "#/domain/memory-overview";
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
/** Memory hexagon radius in graph units (about 30px across at 1x). */
const HEX = 15;

/** A hexagon with rounded corners, pointy top, centred on 0,0. */
export function hexagonPath(radius: number, round = radius * 0.2) {
	const corners = Array.from({ length: 6 }, (_, index) => {
		const angle = (Math.PI / 3) * index - Math.PI / 2;
		return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const;
	});
	const toward = (
		from: readonly [number, number],
		to: readonly [number, number],
		distance: number,
	) => {
		const dx = to[0] - from[0];
		const dy = to[1] - from[1];
		const length = Math.hypot(dx, dy);
		return [
			from[0] + (dx / length) * distance,
			from[1] + (dy / length) * distance,
		] as const;
	};
	let path = "";
	corners.forEach((corner, index) => {
		const before = corners[(index + 5) % 6];
		const after = corners[(index + 1) % 6];
		const start = toward(corner, before, round);
		const end = toward(corner, after, round);
		path += `${index === 0 ? "M" : "L"}${start[0].toFixed(2)} ${start[1].toFixed(2)}Q${corner[0].toFixed(2)} ${corner[1].toFixed(2)} ${end[0].toFixed(2)} ${end[1].toFixed(2)}`;
	});
	return `${path}Z`;
}

const HEX_PATH = hexagonPath(HEX);
const HALO_PATH = hexagonPath(HEX + 6, 4);

/** One memory: the same rounded hexagon always; status as corner badges. */
export function MemoryHexagon({
	memory,
	selected,
	hovered,
}: {
	memory: Pick<
		GraphMemory,
		"forgotten" | "expiring" | "recent" | "version" | "versions"
	> & { row: Pick<GraphMemory["row"], "kind" | "rule"> };
	selected?: boolean;
	hovered?: boolean;
}) {
	const older = memory.version < memory.versions || memory.forgotten;
	const status = memory.forgotten
		? "forgotten"
		: memory.expiring
			? "expiring"
			: memory.recent
				? "new"
				: null;
	const corner = HEX * 0.72;
	return (
		<g
			className="memory-hex"
			data-older={older ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			data-hovered={hovered ? "true" : undefined}
		>
			{selected ? <path className="memory-hex-halo" d={HALO_PATH} /> : null}
			<path
				className="memory-hex-shape"
				d={HEX_PATH}
				data-inferred={memory.row.kind === "inferred" ? "true" : undefined}
			/>
			{status === "forgotten" ? (
				<g
					className="memory-hex-badge"
					data-status="forgotten"
					transform={`translate(${corner} ${-corner})`}
				>
					<circle r={4.2} />
					<path d="M-1.8 -1.8L1.8 1.8M1.8 -1.8L-1.8 1.8" />
				</g>
			) : status ? (
				<circle
					className="memory-hex-badge"
					data-status={status}
					cx={corner}
					cy={-corner}
					r={3.6}
				/>
			) : null}
			{memory.row.rule ? (
				<g
					className="memory-hex-badge"
					data-status="rule"
					transform={`translate(${-corner} ${-corner})`}
				>
					<circle r={5.2} />
					<Pin x={-3.5} y={-3.5} width={7} height={7} strokeWidth={2.4} />
				</g>
			) : null}
		</g>
	);
}

/** A source hub: a rounded rectangle with the chat (or person) glyph. */
export function MemoryHubMark({
	hub,
	active,
}: {
	hub: Pick<GraphHub, "id">;
	active?: boolean;
}) {
	const Icon =
		hub.id === MANUAL_HUB
			? User
			: hub.id === UNKNOWN_HUB
				? Archive
				: MessageSquare;
	return (
		<g className="memory-hub" data-active={active ? "true" : undefined}>
			<rect x={-22} y={-15} width={44} height={30} rx={8} />
			<Icon x={-7} y={-7} width={14} height={14} strokeWidth={1.6} />
		</g>
	);
}

function edgePath(edge: GraphEdge, a: SimNode, b: SimNode) {
	if (edge.kind !== "similar") return `M${a.x} ${a.y}L${b.x} ${b.y}`;
	const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.15;
	const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.15;
	return `M${a.x} ${a.y}Q${mx} ${my} ${b.x} ${b.y}`;
}

type View = { x: number; y: number; k: number };

/**
 * The memory graph as a full page: a dark canvas with source chats as hubs
 * and memories as hexagons around them, similar and version edges between
 * memories. Pan, zoom, drag nodes; hover for the line; click for details
 * and the same edits as the list.
 */
export function MemoryGraphPage({
	active,
	onOpenChat,
	projects,
}: {
	active: boolean;
	onOpenChat: (chatId: string) => boolean;
	projects?: readonly Pick<Project, "fullName" | "name">[];
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
	const graphData = useQuery({
		queryKey: ["memory-graph", memory.data?.files],
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
	const [legendOpen, setLegendOpen] = useState(true);
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
	const model = useMemo(
		() =>
			memoryGraphModel({
				rows,
				today: date,
				scope: scope === ALL ? null : scope,
				chatTitles: graphData.data?.titles,
				similar: graphData.data?.similar.pairs,
			}),
		[rows, date, scope, graphData.data],
	);
	const nodes = useMemo(() => settleLayout(model), [model]);
	const byId = useMemo(
		() => new Map(nodes.map((node) => [node.id, node])),
		[nodes],
	);
	const memories = useMemo(
		() => new Map(model.memories.map((entry) => [entry.id, entry])),
		[model],
	);
	const hubs = useMemo(
		() => new Map(model.hubs.map((hub) => [hub.id, hub])),
		[model],
	);
	const [, setFrame] = useState(0);
	const frame = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
	const fitted = useRef<SimNode[] | null>(null);
	const fitView = useCallback(() => {
		const element = frame.current;
		if (!element) return;
		const box = layoutBounds(nodes, 70);
		const width = element.clientWidth || 800;
		const height = element.clientHeight || 600;
		const k = Math.max(
			0.25,
			Math.min(1.5, Math.min(width / box.width, height / box.height)),
		);
		setView({
			k,
			x: width / 2 - (box.x + box.width / 2) * k,
			y: height / 2 - (box.y + box.height / 2) * k,
		});
	}, [nodes]);
	useEffect(() => {
		if (fitted.current !== nodes && nodes.length) {
			fitted.current = nodes;
			fitView();
		}
	}, [nodes, fitView]);

	// Wheel zoom around the cursor (non-passive, so the page does not scroll).
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			const px = event.clientX - rect.left;
			const py = event.clientY - rect.top;
			setView((current) => {
				const k = Math.max(
					0.2,
					Math.min(4, current.k * Math.exp(-event.deltaY * 0.0015)),
				);
				return {
					k,
					x: px - ((px - current.x) / current.k) * k,
					y: py - ((py - current.y) / current.k) * k,
				};
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, []);

	// While a node is dragged (and briefly after), the simulation keeps running.
	const running = useRef<{ alpha: number; raf: number } | null>(null);
	const kick = useCallback(
		(alpha: number) => {
			if (running.current) {
				running.current.alpha = Math.max(running.current.alpha, alpha);
				return;
			}
			const loop = () => {
				const state = running.current;
				if (!state) return;
				stepLayout(nodes, model.edges, state.alpha);
				state.alpha *= 0.96;
				setFrame((value) => value + 1);
				if (state.alpha < 0.01) {
					running.current = null;
					return;
				}
				state.raf = requestAnimationFrame(loop);
			};
			running.current = { alpha, raf: requestAnimationFrame(loop) };
		},
		[nodes, model.edges],
	);
	useEffect(
		() => () => {
			if (running.current) cancelAnimationFrame(running.current.raf);
			running.current = null;
		},
		[],
	);

	const gesture = useRef<
		| {
				kind: "node";
				node: SimNode;
				startX: number;
				startY: number;
				moved: boolean;
		  }
		| {
				kind: "pan";
				startX: number;
				startY: number;
				view: View;
				moved: boolean;
		  }
		| null
	>(null);
	const nodeAt = (target: EventTarget | null) => {
		const id = (target as Element | null)
			?.closest?.("[data-node]")
			?.getAttribute("data-node");
		return id ? byId.get(id) : undefined;
	};
	const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
		if (event.button !== 0) return;
		const node = nodeAt(event.target);
		event.currentTarget.setPointerCapture(event.pointerId);
		gesture.current = node
			? {
					kind: "node",
					node,
					startX: event.clientX,
					startY: event.clientY,
					moved: false,
				}
			: {
					kind: "pan",
					startX: event.clientX,
					startY: event.clientY,
					view,
					moved: false,
				};
		if (node) node.fixed = true;
	};
	const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
		const current = gesture.current;
		if (!current) {
			const node = nodeAt(event.target);
			const rect = frame.current?.getBoundingClientRect();
			if (node && rect)
				setHovered({
					id: node.id,
					left: event.clientX - rect.left,
					top: event.clientY - rect.top,
				});
			else if (hovered) setHovered(null);
			return;
		}
		const dx = event.clientX - current.startX;
		const dy = event.clientY - current.startY;
		if (Math.hypot(dx, dy) > 3) current.moved = true;
		if (!current.moved) return;
		if (current.kind === "pan") {
			setView({
				...current.view,
				x: current.view.x + dx,
				y: current.view.y + dy,
			});
			return;
		}
		const rect = frame.current?.getBoundingClientRect();
		if (!rect) return;
		current.node.x = (event.clientX - rect.left - view.x) / view.k;
		current.node.y = (event.clientY - rect.top - view.y) / view.k;
		setHovered(null);
		kick(0.3);
	};
	const onPointerUp = () => {
		const current = gesture.current;
		gesture.current = null;
		if (!current) return;
		if (current.kind === "node") {
			current.node.fixed = false;
			if (!current.moved)
				setSelected((value) =>
					value === current.node.id ? null : current.node.id,
				);
			else kick(0.15);
		} else if (!current.moved) setSelected(null);
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
	const linked = new Set<string>();
	if (focus)
		for (const edge of model.edges)
			if (edge.from === focus || edge.to === focus) {
				linked.add(edge.id);
				linked.add(edge.from);
				linked.add(edge.to);
			}
	const total = model.memories.length;
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
	const hoveredMemory = hovered ? memories.get(hovered.id) : undefined;
	const hoveredHub = hovered ? hubs.get(hovered.id) : undefined;
	const selectedMemory = selected ? memories.get(selected) : undefined;
	const selectedHub = selected ? hubs.get(selected) : undefined;
	const grid = 40 * view.k;
	return (
		<section className="memory-graph-page" aria-label="Memory graph">
			<div
				ref={frame}
				className="memory-graph-canvas"
				style={{
					backgroundSize: `${grid}px ${grid}px`,
					backgroundPosition: `${view.x}px ${view.y}px`,
				}}
			>
				{model.memories.length ? (
					<svg
						className="memory-graph-svg"
						role="img"
						aria-label={`Memory graph: ${model.memories.length} memories from ${model.hubs.length} sources`}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerUp}
						onPointerLeave={() => setHovered(null)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setSelected(null);
						}}
					>
						<g
							transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
							data-focus={focus ? "true" : undefined}
						>
							<g className="memory-graph-edges">
								{model.edges.map((edge) => {
									const a = byId.get(edge.from);
									const b = byId.get(edge.to);
									if (!a || !b) return null;
									const d = edgePath(edge, a, b);
									const active = linked.has(edge.id) ? "true" : undefined;
									return edge.kind === "version" ? (
										<g key={edge.id}>
											<path d={d} data-kind="version" data-active={active} />
											<path
												d={d}
												data-kind="version-core"
												data-active={active}
											/>
										</g>
									) : (
										<path
											key={edge.id}
											d={d}
											data-kind={edge.kind}
											data-active={active}
											style={
												edge.kind === "similar"
													? { opacity: 0.15 + edge.weight * 0.45 }
													: undefined
											}
										/>
									);
								})}
							</g>
							<g className="memory-graph-nodes">
								{nodes.map((node) => {
									const hub = hubs.get(node.id);
									const entry = memories.get(node.id);
									return (
										<g
											key={node.id}
											data-node={node.id}
											data-linked={
												focus && (linked.has(node.id) || node.id === focus)
													? "true"
													: undefined
											}
											transform={`translate(${node.x} ${node.y})`}
										>
											{hub ? (
												<MemoryHubMark
													hub={hub}
													active={selected === node.id}
												/>
											) : entry ? (
												<MemoryHexagon
													memory={entry}
													selected={selected === node.id}
													hovered={hovered?.id === node.id}
												/>
											) : null}
										</g>
									);
								})}
							</g>
						</g>
					</svg>
				) : (
					<p className="memory-graph-empty">No memory here yet.</p>
				)}
				{hoveredMemory || hoveredHub ? (
					<div
						className="memory-graph-tip"
						role="tooltip"
						style={{ left: hovered?.left, top: hovered?.top }}
						data-flip={
							frame.current &&
							(hovered?.left ?? 0) > frame.current.clientWidth * 0.6
								? "true"
								: undefined
						}
					>
						{hoveredMemory ? (
							<>
								<p>{hoveredMemory.row.text}</p>
								<span>
									{scopeTitle(hoveredMemory.scope)}
									{hoveredMemory.row.added
										? ` · ${formatMemoryDate(hoveredMemory.row.added)}`
										: ""}
								</span>
							</>
						) : hoveredHub ? (
							<>
								<p>{hoveredHub.label}</p>
								<span>
									{hoveredHub.count}{" "}
									{hoveredHub.count === 1 ? "memory" : "memories"}
								</span>
							</>
						) : null}
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
					<Eye size={15} aria-hidden="true" />
					<span>
						<strong>{scope === ALL ? "All memory" : scopeTitle(scope)}</strong>
						<small>
							{total} {total === 1 ? "memory" : "memories"}
						</small>
					</span>
					<ChevronDown size={14} aria-hidden="true" />
				</button>
			</MemoryScopeMenu>

			<div className="memory-graph-card memory-graph-zoom">
				<button
					type="button"
					aria-label="Zoom in"
					onClick={() =>
						setView((current) => zoomAt(current, 1.25, frame.current))
					}
				>
					<Plus size={14} />
				</button>
				<button
					type="button"
					aria-label="Zoom out"
					onClick={() =>
						setView((current) => zoomAt(current, 0.8, frame.current))
					}
				>
					<Minus size={14} />
				</button>
				<button type="button" aria-label="Fit to screen" onClick={fitView}>
					<Maximize2 size={13} />
				</button>
			</div>

			{selectedMemory ? (
				<MemoryDetails
					key={selectedMemory.id}
					memory={selectedMemory}
					hubLabel={hubs.get(selectedMemory.hub)?.label}
					scopeLabel={scopeTitle(selectedMemory.scope)}
					choices={choices}
					busy={edit.isPending}
					error={
						edit.data && !edit.data.ok ? edit.data.error : edit.error?.message
					}
					onClose={() => setSelected(null)}
					onOpenChat={onOpenChat}
					onEdit={(data) => edit.mutate(data)}
				/>
			) : selectedHub ? (
				<aside className="memory-graph-card memory-graph-details">
					<header>
						<MessageSquare size={14} aria-hidden="true" />
						<h2>{selectedHub.chatId ? "Chat" : "Source"}</h2>
						<button
							type="button"
							aria-label="Close"
							onClick={() => setSelected(null)}
						>
							<X size={14} />
						</button>
					</header>
					<p className="memory-graph-text">{selectedHub.label}</p>
					<p className="memory-graph-foot">
						{selectedHub.count}{" "}
						{selectedHub.count === 1 ? "memory" : "memories"}
						{selectedHub.chatId ? (
							<a
								href={`/?chat=${selectedHub.chatId}`}
								onClick={(event) => {
									if (selectedHub.chatId && onOpenChat(selectedHub.chatId))
										event.preventDefault();
								}}
							>
								Open chat
							</a>
						) : null}
					</p>
				</aside>
			) : null}

			<aside
				className="memory-graph-card memory-graph-legend"
				data-open={legendOpen ? "true" : undefined}
				aria-label="Legend"
			>
				<button
					type="button"
					className="memory-graph-legend-toggle"
					aria-expanded={legendOpen}
					onClick={() => setLegendOpen((value) => !value)}
				>
					Legend
					<ChevronDown size={13} aria-hidden="true" />
				</button>
				{legendOpen ? (
					<MemoryGraphLegend
						similarBasis={graphData.data?.similar.basis ?? "words"}
					/>
				) : null}
			</aside>
		</section>
	);
}

function zoomAt(view: View, factor: number, element: HTMLElement | null) {
	const width = element?.clientWidth ?? 800;
	const height = element?.clientHeight ?? 600;
	const k = Math.max(0.2, Math.min(4, view.k * factor));
	return {
		k,
		x: width / 2 - ((width / 2 - view.x) / view.k) * k,
		y: height / 2 - ((height / 2 - view.y) / view.k) * k,
	};
}

/** The selected memory: its text, where it applies, its version, and the list's edits. */
function MemoryDetails({
	memory,
	hubLabel,
	scopeLabel,
	choices,
	busy,
	error,
	onClose,
	onOpenChat,
	onEdit,
}: {
	memory: GraphMemory;
	hubLabel?: string;
	scopeLabel: string;
	choices: ReturnType<typeof useMemoryScopeNames>["choices"];
	busy: boolean;
	error?: string;
	onClose: () => void;
	onOpenChat: (chatId: string) => boolean;
	onEdit: (edit: MemoryEdit) => void;
}) {
	const { row } = memory;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(row.text);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ref = memoryLineRef(row);
	const status = memory.forgotten
		? "Replaced"
		: memory.expiring
			? `Expires ${row.expires}`
			: memory.recent
				? "New"
				: null;
	return (
		<aside className="memory-graph-card memory-graph-details">
			<header>
				<svg viewBox="-17 -17 34 34" width={16} height={16} aria-hidden="true">
					<path className="memory-hex-icon" d={HEX_PATH} />
				</svg>
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
						v{memory.version}
						{memory.versions > 1 ? ` of ${memory.versions}` : ""}
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
						title={hubLabel}
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

/** The legend, drawn with the graph's own marks. */
export function MemoryGraphLegend({
	similarBasis,
}: {
	similarBasis: "meaning" | "words";
}) {
	const base = {
		forgotten: false,
		expiring: false,
		recent: false,
		version: 1,
		versions: 1,
		row: { kind: "stated" as const, rule: false },
	};
	const mark = (child: ReactNode, width = 40) => (
		<svg
			viewBox={`${-width / 2} -18 ${width} 36`}
			width={width / 1.6}
			height={22}
			aria-hidden="true"
		>
			{child}
		</svg>
	);
	const line = (kind: GraphEdge["kind"], opacity?: number) => (
		<svg viewBox="0 0 36 12" width={30} height={10} aria-hidden="true">
			<g className="memory-graph-edges">
				<path
					d="M2 6L34 6"
					data-kind={kind}
					data-active="true"
					style={opacity === undefined ? undefined : { opacity }}
				/>
				{kind === "version" ? (
					<path d="M2 6L34 6" data-kind="version-core" data-active="true" />
				) : null}
			</g>
		</svg>
	);
	return (
		<div className="memory-graph-legend-body">
			<h3>Nodes</h3>
			<ul>
				<li>
					{mark(<MemoryHubMark hub={{ id: "hub:x" }} />, 50)}
					Chat
				</li>
				<li>
					{mark(<MemoryHexagon memory={base} />)}
					Memory
				</li>
				<li>
					{mark(
						<MemoryHexagon memory={{ ...base, version: 1, versions: 2 }} />,
					)}
					Older version
				</li>
				<li>
					{mark(
						<MemoryHexagon
							memory={{ ...base, row: { kind: "inferred", rule: false } }}
						/>,
					)}
					Inferred
				</li>
			</ul>
			<h3>Status</h3>
			<ul>
				<li>
					{mark(<MemoryHexagon memory={{ ...base, recent: true }} />)}
					New
				</li>
				<li>
					{mark(<MemoryHexagon memory={{ ...base, expiring: true }} />)}
					Expiring soon
				</li>
				<li>
					{mark(<MemoryHexagon memory={{ ...base, forgotten: true }} />)}
					Retired
				</li>
				<li>
					{mark(
						<MemoryHexagon
							memory={{ ...base, row: { kind: "stated", rule: true } }}
						/>,
					)}
					Always on
				</li>
			</ul>
			<h3>Connections</h3>
			<ul>
				<li>
					{line("source")}
					From chat
				</li>
				<li>
					{line("similar", 0.6)}
					{similarBasis === "meaning" ? "Similar" : "Shared words"}
				</li>
				<li>
					{line("version")}
					Newer version
				</li>
			</ul>
			<h3>Similarity</h3>
			<ul className="memory-graph-legend-row">
				<li>
					{line("similar", 0.18)}
					Weak
				</li>
				<li>
					{line("similar", 0.6)}
					Strong
				</li>
			</ul>
		</div>
	);
}
