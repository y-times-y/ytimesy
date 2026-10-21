import {
	type CSSProperties,
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { MemoryGraph, MemoryGraphNode } from "#/domain/memory-graph";

/**
 * Calm, low-chroma hues for scope clusters, in scope order (Personal first).
 * Amber stays reserved for always-on rules, as in the row badges.
 */
const CLUSTER_HUES = [
	"#8fa8d8",
	"#7fb8aa",
	"#a99bd0",
	"#c99aa8",
	"#9fb88a",
	"#8fb3c4",
	"#c4ae8f",
];

export const clusterHue = (index: number) =>
	CLUSTER_HUES[index % CLUSTER_HUES.length];

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

function Diamond({ x, y, r }: { x: number; y: number; r: number }) {
	const s = r * 1.25;
	return (
		<path
			className="memory-map-node-shape"
			d={`M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`}
		/>
	);
}

/** One memory line as a mark: filled for stated, ring for inferred, diamond for always-on rules. */
const NodeMark = memo(function NodeMark({
	node,
	hue,
}: {
	node: MemoryGraphNode;
	hue: string;
}) {
	const { row, x, y, r } = node;
	return (
		<g
			className="memory-map-node"
			data-id={node.id}
			data-kind={row.rule ? "rule" : row.kind}
			data-recent={node.recent ? "true" : undefined}
			style={{ "--hue": hue } as CSSProperties}
		>
			{node.recent ? (
				<circle className="memory-map-halo" cx={x} cy={y} r={r + 3.2} />
			) : null}
			{row.rule ? (
				<Diamond x={x} y={y} r={r} />
			) : (
				<circle
					className="memory-map-node-shape"
					cx={x}
					cy={y}
					r={row.kind === "inferred" ? r - 0.6 : r}
				/>
			)}
			<circle className="memory-map-hit" cx={x} cy={y} r={r + 4} />
		</g>
	);
});

/**
 * The memory map. Hover a node for its line, click it to select the line in
 * the list, click a cluster to filter the list to that scope. Interaction is
 * delegated on the SVG, so a few hundred nodes stay cheap.
 */
export function MemoryGraphView({
	graph,
	hues,
	scopeFilter,
	selected,
	onSelectNode,
	onSelectScope,
	topicTitle,
	scopeTitle,
	onAspect,
}: {
	graph: MemoryGraph;
	/** Hue per cluster id. */
	hues: Readonly<Record<string, string>>;
	scopeFilter: string | null;
	selected: string | null;
	onSelectNode: (node: MemoryGraphNode) => void;
	onSelectScope: (scope: string | null) => void;
	topicTitle: (path: string) => string;
	scopeTitle: (scope: string) => string;
	/** The drawing area's width over height, so the layout can fill it. */
	onAspect?: (aspect: number) => void;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<{
		node: MemoryGraphNode;
		left: number;
		top: number;
	} | null>(null);
	useEffect(() => {
		const element = frame.current;
		if (!element || !onAspect || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			if (width > 0 && height > 0)
				onAspect(
					Math.min(2.4, Math.max(0.6, Math.round((width / height) * 5) / 5)),
				);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [onAspect]);
	const byId = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node])),
		[graph],
	);
	const focus = hover?.node.id ?? selected;
	const linked = useMemo(() => {
		const ids = new Set<string>();
		if (!focus) return ids;
		for (const edge of graph.edges)
			if (edge.from === focus || edge.to === focus) {
				ids.add(edge.id);
				ids.add(edge.from);
				ids.add(edge.to);
			}
		return ids;
	}, [graph, focus]);
	const nodeAt = (target: EventTarget | null) => {
		const element = (target as Element | null)?.closest?.(".memory-map-node");
		const id = element?.getAttribute("data-id");
		return id ? byId.get(id) : undefined;
	};
	const { box } = graph;
	const selectedNode = selected ? byId.get(selected) : undefined;
	return (
		<div
			ref={frame}
			className="memory-map"
			data-filtered={scopeFilter ? "true" : undefined}
		>
			<svg
				className="memory-map-svg"
				viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
				preserveAspectRatio="xMidYMid meet"
				role="img"
				aria-label={`Memory map: ${graph.nodes.length} memories in ${graph.clusters.length} ${graph.clusters.length === 1 ? "scope" : "scopes"}`}
				onPointerMove={(event) => {
					const node = nodeAt(event.target);
					if (!node) {
						if (hover) setHover(null);
						return;
					}
					const rect = frame.current?.getBoundingClientRect();
					if (!rect) return;
					setHover({
						node,
						left: event.clientX - rect.left,
						top: event.clientY - rect.top,
					});
				}}
				onPointerLeave={() => setHover(null)}
				onKeyDown={(event) => {
					if (event.key === "Escape" && scopeFilter) onSelectScope(null);
				}}
				onClick={(event) => {
					const node = nodeAt(event.target);
					if (node) {
						onSelectNode(node);
						return;
					}
					const cluster = (event.target as Element).closest?.("[data-cluster]");
					const id = cluster?.getAttribute("data-cluster");
					if (id) onSelectScope(scopeFilter === id ? null : id);
					else if (scopeFilter) onSelectScope(null);
				}}
			>
				<g className="memory-map-clusters">
					{graph.clusters.map((cluster) => (
						<g
							key={cluster.id}
							className="memory-map-cluster"
							data-cluster={cluster.id}
							data-active={scopeFilter === cluster.id ? "true" : undefined}
							data-dim={
								scopeFilter && scopeFilter !== cluster.id ? "true" : undefined
							}
							style={{ "--hue": hues[cluster.id] } as CSSProperties}
						>
							<circle
								className="memory-map-cluster-area"
								cx={cluster.x}
								cy={cluster.y}
								r={cluster.r}
							/>
							{cluster.topics.map((topic) => (
								<g key={topic.id} className="memory-map-topic">
									<circle cx={topic.x} cy={topic.y} r={topic.r} />
									{topic.r > 20 ? (
										<text x={topic.x} y={topic.y + topic.r + 9}>
											{topicTitle(topic.path)}
										</text>
									) : null}
								</g>
							))}
							<text
								className="memory-map-cluster-label"
								x={cluster.x}
								y={cluster.y - cluster.r - 7}
							>
								{scopeTitle(cluster.id)}
								<tspan className="memory-map-cluster-count" dx={6}>
									{cluster.count}
								</tspan>
							</text>
						</g>
					))}
				</g>
				<g className="memory-map-edges">
					{graph.edges.map((edge) => {
						const mx = (edge.x1 + edge.x2) / 2;
						const my = (edge.y1 + edge.y2) / 2;
						// A gentle bow, so overlapping chains read as separate strokes.
						const bow = 0.12;
						const cx = mx - (edge.y2 - edge.y1) * bow;
						const cy = my + (edge.x2 - edge.x1) * bow;
						return (
							<path
								key={edge.id}
								data-kind={edge.kind}
								data-active={linked.has(edge.id) ? "true" : undefined}
								d={`M${edge.x1} ${edge.y1}Q${cx} ${cy} ${edge.x2} ${edge.y2}`}
							/>
						);
					})}
				</g>
				<g className="memory-map-nodes" data-focus={focus ? "true" : undefined}>
					{graph.nodes.map((node) => (
						<g
							key={node.id}
							data-dim={
								scopeFilter && node.scope !== scopeFilter ? "true" : undefined
							}
							data-linked={
								focus && (linked.has(node.id) || node.id === focus)
									? "true"
									: undefined
							}
						>
							<NodeMark node={node} hue={hues[node.scope] ?? CLUSTER_HUES[0]} />
						</g>
					))}
				</g>
				{selectedNode ? (
					<circle
						className="memory-map-selected"
						cx={selectedNode.x}
						cy={selectedNode.y}
						r={selectedNode.r + 4.5}
					/>
				) : null}
			</svg>
			{hover ? (
				<div
					className="memory-map-tip"
					role="tooltip"
					style={{
						left: hover.left,
						top: hover.top,
					}}
					data-flip={
						frame.current && hover.left > frame.current.clientWidth * 0.6
							? "true"
							: undefined
					}
				>
					<p>{hover.node.row.text}</p>
					<span>
						{hover.node.row.rule ? "Always-on rule · " : ""}
						{hover.node.row.kind === "inferred" ? "Inferred" : "Stated"} ·{" "}
						{scopeTitle(hover.node.scope)} · {topicTitle(hover.node.row.path)}
						{hover.node.row.added
							? ` · ${formatDate(hover.node.row.added)}`
							: ""}
					</span>
				</div>
			) : null}
			<ul className="memory-map-legend" aria-label="Map legend">
				<li>
					<svg viewBox="-6 -6 12 12" aria-hidden="true">
						<circle r={4} data-legend="stated" />
					</svg>
					Stated
				</li>
				<li>
					<svg viewBox="-6 -6 12 12" aria-hidden="true">
						<circle r={3.6} data-legend="inferred" />
					</svg>
					Inferred
				</li>
				<li>
					<svg viewBox="-6 -6 12 12" aria-hidden="true">
						<path d="M0 -5L5 0L0 5L-5 0Z" data-legend="rule" />
					</svg>
					Always-on rule
				</li>
				<li>
					<svg viewBox="-6 -6 12 12" aria-hidden="true">
						<circle r={5} data-legend="recent" />
						<circle r={2.6} data-legend="stated" />
					</svg>
					This week
				</li>
				<li>
					<svg viewBox="0 -6 16 12" aria-hidden="true">
						<path d="M1 2Q8 -4 15 2" data-legend="edge" />
					</svg>
					Same chat or link
				</li>
			</ul>
		</div>
	);
}
