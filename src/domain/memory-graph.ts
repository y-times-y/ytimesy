import {
	type MemoryRow,
	type MemoryScope,
	memoryEntries,
	rowScope,
} from "./memory-overview";
import { memoryLinks } from "./memory-repo";

/**
 * The memory map: each scope (Personal, a project) is a cluster, each topic
 * file a circle inside it, each memory line a node inside its topic. Nodes
 * sit on a sunflower spiral (always-on rules at the centre, then newest
 * first); topic circles and clusters are packed by a small deterministic
 * force pass. Edges join lines from the same source chat and lines that
 * `[[link]]` a topic. Pure and computed once per repo state, so a few
 * hundred lines lay out in well under a frame.
 */

export type MemoryGraphNode = {
	readonly id: string;
	readonly row: MemoryRow;
	readonly scope: string;
	readonly topic: string;
	readonly x: number;
	readonly y: number;
	readonly r: number;
	/** Added in the last week. */
	readonly recent: boolean;
};

export type MemoryGraphTopic = {
	readonly id: string;
	readonly path: string;
	readonly title: string;
	readonly x: number;
	readonly y: number;
	readonly r: number;
};

export type MemoryGraphCluster = {
	readonly id: string;
	readonly title: string;
	readonly count: number;
	readonly x: number;
	readonly y: number;
	readonly r: number;
	readonly topics: readonly MemoryGraphTopic[];
};

export type MemoryGraphEdge = {
	readonly id: string;
	readonly kind: "chat" | "link";
	readonly from: string;
	/** A node id, or a topic id for a link. */
	readonly to: string;
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
};

export type MemoryGraph = {
	readonly nodes: readonly MemoryGraphNode[];
	readonly clusters: readonly MemoryGraphCluster[];
	readonly edges: readonly MemoryGraphEdge[];
	/** Bounds of everything drawn, for the SVG viewBox. */
	readonly box: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
};

const SPACING = 14;
const TOPIC_PAD = 9;
const CLUSTER_PAD = 16;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const DAY = 86_400_000;

export const nodeId = (row: Pick<MemoryRow, "path" | "line">) =>
	`${row.path}:${row.line}`;

function daysSince(date: string | undefined, today: string) {
	if (!date) return Number.POSITIVE_INFINITY;
	const delta =
		Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
	return Number.isNaN(delta) ? Number.POSITIVE_INFINITY : delta / DAY;
}

/** Node radius by recency: newer lines are a little larger. */
export function nodeRadius(row: Pick<MemoryRow, "added">, today: string) {
	const days = daysSince(row.added, today);
	return days <= 7 ? 5.6 : days <= 30 ? 4.5 : 3.6;
}

type Circle = { x: number; y: number; r: number };

/**
 * Packs circles around the origin without overlap: seeded on a spiral in
 * the given order, then pulled to the centre (stretched by `aspect`) and
 * pushed apart. Deterministic; n is small (topics, scopes).
 */
export function packCircles(
	radii: readonly number[],
	options: { gap: number; aspect?: number; iterations?: number } = { gap: 8 },
): Circle[] {
	const aspect = options.aspect ?? 1;
	const circles = radii.map((r, index) => {
		const distance = index === 0 ? 0 : (radii[0] + r) * Math.sqrt(index) * 0.9;
		return {
			x: Math.cos(index * GOLDEN) * distance * Math.sqrt(aspect),
			y: (Math.sin(index * GOLDEN) * distance) / Math.sqrt(aspect),
			r,
		};
	});
	const iterations = options.iterations ?? 220;
	for (let step = 0; step < iterations; step++) {
		const pull = 0.04 * (1 - step / iterations);
		for (const circle of circles) {
			circle.x -= (circle.x / aspect) * pull;
			circle.y -= circle.y * aspect * pull;
		}
		for (let a = 0; a < circles.length; a++)
			for (let b = a + 1; b < circles.length; b++) {
				const left = circles[a];
				const right = circles[b];
				let dx = right.x - left.x;
				let dy = right.y - left.y;
				let distance = Math.hypot(dx, dy);
				if (distance < 1e-6) {
					dx = Math.cos(b);
					dy = Math.sin(b);
					distance = 1;
				}
				const min = left.r + right.r + options.gap;
				if (distance >= min) continue;
				const push = (min - distance) / 2 / distance;
				const total = left.r * left.r + right.r * right.r;
				const leftShare = (right.r * right.r) / total;
				const rightShare = (left.r * left.r) / total;
				left.x -= dx * push * 2 * leftShare;
				left.y -= dy * push * 2 * leftShare;
				right.x += dx * push * 2 * rightShare;
				right.y += dy * push * 2 * rightShare;
			}
	}
	return circles;
}

/**
 * Scopes in rows, in order, choosing the column count whose bounds best
 * fill a space of the given aspect (width / height); each row is centred.
 * Few scopes, so every count is tried.
 */
export function arrangeClusters(
	radii: readonly number[],
	aspect: number,
	gap: number,
): Circle[] {
	if (!radii.length) return [];
	let best: { circles: Circle[]; scale: number } | null = null;
	for (let columns = 1; columns <= radii.length; columns++) {
		const rows: number[][] = [];
		radii.forEach((_, index) => {
			const row = Math.floor(index / columns);
			rows[row] = [...(rows[row] ?? []), index];
		});
		const widths = rows.map(
			(row) =>
				row.reduce((sum, index) => sum + radii[index] * 2, 0) +
				gap * (row.length - 1),
		);
		const heights = rows.map((row) =>
			Math.max(...row.map((index) => radii[index] * 2)),
		);
		const width = Math.max(...widths);
		const height =
			heights.reduce((sum, value) => sum + value, 0) + gap * (rows.length - 1);
		const scale = Math.min(aspect / width, 1 / height);
		if (best && scale <= best.scale) continue;
		const circles: Circle[] = [];
		let y = -height / 2;
		rows.forEach((row, r) => {
			let x = -widths[r] / 2;
			for (const index of row) {
				circles[index] = {
					x: x + radii[index],
					y: y + heights[r] / 2,
					r: radii[index],
				};
				x += radii[index] * 2 + gap;
			}
			y += heights[r] + gap;
		});
		best = { circles, scale };
	}
	return best?.circles ?? [];
}

/** The radius a sunflower spiral of `count` nodes needs. */
const spiralRadius = (count: number) =>
	SPACING * Math.sqrt(Math.max(count, 1)) + TOPIC_PAD;

export function memoryGraph(input: {
	rows: readonly MemoryRow[];
	scopes: readonly MemoryScope[];
	titles: Readonly<Record<string, string>>;
	scopeTitle: (scope: MemoryScope) => string;
	today: string;
	/** Width over height of the space the map is drawn in. */
	aspect?: number;
}): MemoryGraph {
	const live = memoryEntries(input.rows).filter((row) => !row.replaced);
	const scopes = input.scopes.filter((scope) =>
		live.some((row) => rowScope(row) === scope.id),
	);
	const nodes: MemoryGraphNode[] = [];
	const clusters: MemoryGraphCluster[] = [];
	const layouts = scopes.map((scope) => {
		const own = live.filter((row) => rowScope(row) === scope.id);
		const byTopic = new Map<string, MemoryRow[]>();
		for (const row of own)
			byTopic.set(row.path, [...(byTopic.get(row.path) ?? []), row]);
		const topics = [...byTopic.entries()].sort(
			(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
		);
		const packed = packCircles(
			topics.map(([, rows]) => spiralRadius(rows.length)),
			{ gap: 6 },
		);
		const extent = Math.max(
			...packed.map((circle) => Math.hypot(circle.x, circle.y) + circle.r),
		);
		return { scope, topics, packed, r: extent + CLUSTER_PAD };
	});
	const placed = arrangeClusters(
		layouts.map((layout) => layout.r),
		input.aspect ?? 1.4,
		26,
	);
	layouts.forEach((layout, index) => {
		const center = placed[index];
		const topics: MemoryGraphTopic[] = layout.topics.map(([path, rows], t) => {
			const circle = layout.packed[t];
			const x = center.x + circle.x;
			const y = center.y + circle.y;
			const ordered = [...rows].sort(
				(a, b) =>
					Number(b.rule) - Number(a.rule) ||
					(b.added ?? "").localeCompare(a.added ?? "") ||
					a.line - b.line,
			);
			ordered.forEach((row, i) => {
				const distance = SPACING * Math.sqrt(i + 0.5) - SPACING * 0.5;
				nodes.push({
					id: nodeId(row),
					row,
					scope: layout.scope.id,
					topic: `${layout.scope.id}|${path}`,
					x: x + Math.cos(i * GOLDEN) * distance,
					y: y + Math.sin(i * GOLDEN) * distance,
					r: nodeRadius(row, input.today),
					recent: daysSince(row.added, input.today) <= 7,
				});
			});
			return {
				id: `${layout.scope.id}|${path}`,
				path,
				title: input.titles[path] ?? path.replace(/\.md$/, ""),
				x,
				y,
				r: circle.r,
			};
		});
		clusters.push({
			id: layout.scope.id,
			title: input.scopeTitle(layout.scope),
			count: layout.topics.reduce((sum, [, rows]) => sum + rows.length, 0),
			x: center.x,
			y: center.y,
			r: layout.r,
			topics,
		});
	});
	const edges = memoryGraphEdges(nodes, clusters);
	const pad = 28;
	const minX = Math.min(...clusters.map((c) => c.x - c.r), 0) - pad;
	const maxX = Math.max(...clusters.map((c) => c.x + c.r), 0) + pad;
	// Room above each cluster for its label.
	const minY = Math.min(...clusters.map((c) => c.y - c.r), 0) - pad - 14;
	const maxY = Math.max(...clusters.map((c) => c.y + c.r), 0) + pad;
	return {
		nodes,
		clusters,
		edges,
		box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
	};
}

/**
 * Same-chat edges join each chat's lines in a chain (not every pair, so a
 * busy chat stays a few strokes), and each `[[link]]` joins its line to the
 * linked topic, preferring the topic's circle in the line's own scope.
 */
export function memoryGraphEdges(
	nodes: readonly MemoryGraphNode[],
	clusters: readonly MemoryGraphCluster[],
): MemoryGraphEdge[] {
	const edges: MemoryGraphEdge[] = [];
	const byChat = new Map<string, MemoryGraphNode[]>();
	for (const node of nodes)
		if (node.row.chatId)
			byChat.set(node.row.chatId, [
				...(byChat.get(node.row.chatId) ?? []),
				node,
			]);
	for (const group of byChat.values())
		for (let index = 1; index < group.length; index++) {
			const a = group[index - 1];
			const b = group[index];
			edges.push({
				id: `chat:${a.id}>${b.id}`,
				kind: "chat",
				from: a.id,
				to: b.id,
				x1: a.x,
				y1: a.y,
				x2: b.x,
				y2: b.y,
			});
		}
	const topics = clusters.flatMap((cluster) =>
		cluster.topics.map((topic) => ({ topic, scope: cluster.id })),
	);
	for (const node of nodes)
		for (const path of new Set(memoryLinks(node.row.text))) {
			const targets = topics.filter((entry) => entry.topic.path === path);
			const target =
				targets.find((entry) => entry.scope === node.scope) ?? targets[0];
			if (!target || target.topic.id === node.topic) continue;
			edges.push({
				id: `link:${node.id}>${target.topic.id}`,
				kind: "link",
				from: node.id,
				to: target.topic.id,
				x1: node.x,
				y1: node.y,
				x2: target.topic.x,
				y2: target.topic.y,
			});
		}
	return edges;
}
