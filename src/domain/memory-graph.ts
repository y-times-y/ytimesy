import { type MemoryRow, memoryEntries, rowScope } from "./memory-overview";
import { memoryTokens } from "./memory-ranking";
import { cosineSimilarity } from "./memory-repo";

/**
 * The memory graph: each source chat is a hub ("Added by you" for lines the
 * user added, "Earlier memory" for lines with no source), each memory line a
 * node joined to its hub. Similar lines are joined by a dashed edge, and a
 * line a later statement replaced is joined to that later line as a version
 * chain (v1, v2, …). A small force simulation lays it out; the view runs
 * more of it while a node is dragged. Pure.
 */

export const MANUAL_HUB = "hub:manual";
export const UNKNOWN_HUB = "hub:unknown";
/** `expires:` within this many days reads as expiring soon. */
export const EXPIRING_DAYS = 14;
/** Added within this many days reads as new. */
export const NEW_DAYS = 7;

export type GraphHub = {
	readonly id: string;
	readonly label: string;
	readonly chatId?: string;
	readonly count: number;
};

export type GraphMemory = {
	readonly id: string;
	readonly row: MemoryRow;
	readonly hub: string;
	readonly scope: string;
	/** Retired: expired or replaced by a later statement. */
	readonly forgotten: boolean;
	readonly expiring: boolean;
	readonly recent: boolean;
	/** 1-based place in its version chain, and the chain's length. */
	readonly version: number;
	readonly versions: number;
};

export type GraphEdge = {
	readonly id: string;
	readonly kind: "source" | "similar" | "version";
	readonly from: string;
	readonly to: string;
	/** Similarity 0..1 for similar edges; 1 otherwise. */
	readonly weight: number;
};

export type MemoryGraphModel = {
	readonly hubs: readonly GraphHub[];
	readonly memories: readonly GraphMemory[];
	readonly edges: readonly GraphEdge[];
};

export type SimilarPair = {
	readonly a: string;
	readonly b: string;
	readonly score: number;
};

export const nodeId = (row: Pick<MemoryRow, "path" | "line">) =>
	`${row.path}:${row.line}`;

const DAY = 86_400_000;
function days(from: string, to: string) {
	return (
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY
	);
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / Math.max(1, Math.min(a.size, b.size));
}

/**
 * The line that replaced `older`: among lines from the chat its
 * `superseded-by` names, the one sharing the most words (same file first).
 */
function successor(
	older: MemoryRow,
	rows: readonly MemoryRow[],
	tokens: ReadonlyMap<MemoryRow, ReadonlySet<string>>,
) {
	const by = older.supersededBy?.toLowerCase();
	if (!by) return undefined;
	let best: MemoryRow | undefined;
	let score = 0;
	for (const row of rows) {
		if (row === older || row.chatId?.toLowerCase() !== by) continue;
		const value =
			overlap(tokens.get(older) ?? new Set(), tokens.get(row) ?? new Set()) +
			(row.path === older.path ? 0.01 : 0);
		if (value > score) {
			score = value;
			best = row;
		}
	}
	return best;
}

function pairKey(a: string, b: string) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Up to `k` nearest neighbours per line at or above `min`, each pair once. */
export function similarPairs(
	ids: readonly string[],
	vectors: readonly (readonly number[] | undefined)[],
	options: { k?: number; min?: number } = {},
): SimilarPair[] {
	const k = options.k ?? 2;
	const min = options.min ?? 0.6;
	const seen = new Set<string>();
	const pairs: SimilarPair[] = [];
	ids.forEach((id, i) => {
		const own = vectors[i];
		if (!own) return;
		const near: { other: string; score: number }[] = [];
		ids.forEach((other, j) => {
			const vector = vectors[j];
			if (j === i || !vector) return;
			const score = cosineSimilarity(own, vector);
			if (score >= min) near.push({ other, score });
		});
		near.sort((a, b) => b.score - a.score);
		for (const { other, score } of near.slice(0, k)) {
			const key = pairKey(id, other);
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({ a: id, b: other, score });
		}
	});
	return pairs;
}

/**
 * The same pairs by shared words (Jaccard over stemmed words, scaled so
 * `min` reads as strong), for when no line vectors are stored.
 */
export function wordSimilarPairs(
	rows: readonly Pick<MemoryRow, "path" | "line" | "text">[],
	options: { k?: number; min?: number } = {},
): SimilarPair[] {
	const sets = rows.map((row) => new Set(memoryTokens(row.text)));
	const min = options.min ?? 0.5;
	const k = options.k ?? 2;
	const seen = new Set<string>();
	const pairs: SimilarPair[] = [];
	rows.forEach((row, i) => {
		const near: { j: number; score: number }[] = [];
		rows.forEach((_, j) => {
			if (j === i || sets[i].size < 2 || sets[j].size < 2) return;
			let shared = 0;
			for (const token of sets[i]) if (sets[j].has(token)) shared++;
			const score = shared / (sets[i].size + sets[j].size - shared);
			if (score >= min * 0.6) near.push({ j, score });
		});
		near.sort((a, b) => b.score - a.score);
		for (const { j, score } of near.slice(0, k)) {
			const a = nodeId(row);
			const b = nodeId(rows[j]);
			const key = pairKey(a, b);
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({ a, b, score: Math.min(1, score / min) });
		}
	});
	return pairs;
}

export function memoryGraphModel(input: {
	rows: readonly MemoryRow[];
	today: string;
	/** null: every scope. */
	scope: string | null;
	chatTitles?: Readonly<Record<string, string>>;
	similar?: readonly SimilarPair[];
}): MemoryGraphModel {
	const rows = memoryEntries(input.rows).filter(
		(row) => input.scope === null || rowScope(row) === input.scope,
	);
	const tokens = new Map(
		rows.map((row) => [row, new Set(memoryTokens(row.text))] as const),
	);
	const next = new Map<MemoryRow, MemoryRow>();
	const previous = new Map<MemoryRow, MemoryRow>();
	for (const row of rows) {
		const later = successor(row, rows, tokens);
		if (later && !previous.has(later)) {
			next.set(row, later);
			previous.set(later, row);
		}
	}
	const chain = (row: MemoryRow) => {
		let first = row;
		const seen = new Set<MemoryRow>([row]);
		for (let p = previous.get(first); p && !seen.has(p); p = previous.get(p)) {
			seen.add(p);
			first = p;
		}
		let length = 1;
		let position = first === row ? 1 : 0;
		const walked = new Set<MemoryRow>([first]);
		for (let n = next.get(first); n && !walked.has(n); n = next.get(n)) {
			walked.add(n);
			length++;
			if (n === row) position = length;
		}
		return { version: position || 1, versions: length };
	};
	const hubOf = (row: MemoryRow) =>
		row.chatId ? `hub:${row.chatId}` : row.manual ? MANUAL_HUB : UNKNOWN_HUB;
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(hubOf(row), (counts.get(hubOf(row)) ?? 0) + 1);
	const hubs: GraphHub[] = [...counts.entries()].map(([id, count]) => {
		if (id === MANUAL_HUB) return { id, label: "Added by you", count };
		if (id === UNKNOWN_HUB) return { id, label: "Earlier memory", count };
		const chatId = id.slice(4);
		return {
			id,
			chatId,
			label: input.chatTitles?.[chatId]?.trim() || "Chat",
			count,
		};
	});
	const memories: GraphMemory[] = rows.map((row) => {
		const until =
			row.expires && /^\d{4}-\d{2}-\d{2}$/.test(row.expires)
				? days(input.today, row.expires)
				: Number.NaN;
		return {
			id: nodeId(row),
			row,
			hub: hubOf(row),
			scope: rowScope(row),
			forgotten: row.replaced,
			expiring: !row.replaced && until >= 0 && until <= EXPIRING_DAYS,
			recent: Boolean(row.added && days(row.added, input.today) <= NEW_DAYS),
			...chain(row),
		};
	});
	const ids = new Set(memories.map((memory) => memory.id));
	const edges: GraphEdge[] = [
		...memories.map((memory) => ({
			id: `source:${memory.id}`,
			kind: "source" as const,
			from: memory.hub,
			to: memory.id,
			weight: 1,
		})),
		...[...next.entries()].map(([older, newer]) => ({
			id: `version:${nodeId(older)}>${nodeId(newer)}`,
			kind: "version" as const,
			from: nodeId(older),
			to: nodeId(newer),
			weight: 1,
		})),
		...(input.similar ?? [])
			.filter((pair) => ids.has(pair.a) && ids.has(pair.b))
			.map((pair) => ({
				id: `similar:${pairKey(pair.a, pair.b)}`,
				kind: "similar" as const,
				from: pair.a,
				to: pair.b,
				weight: Math.max(0, Math.min(1, pair.score)),
			})),
	];
	return { hubs, memories, edges };
}

// ---- layout -------------------------------------------------------------------

export type SimNode = {
	readonly id: string;
	readonly hub: boolean;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Collision radius. */
	readonly r: number;
	/** Held by a drag: forces do not move it. */
	fixed?: boolean;
};

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Hubs on a sunflower spiral, each hub's memories around it. Deterministic. */
export function seedLayout(model: MemoryGraphModel): SimNode[] {
	const nodes: SimNode[] = [];
	const centres = new Map<string, { x: number; y: number }>();
	model.hubs
		.slice()
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
		.forEach((hub, index) => {
			const distance = 110 * Math.sqrt(index);
			const x = Math.cos(index * GOLDEN) * distance;
			const y = Math.sin(index * GOLDEN) * distance * 0.75;
			centres.set(hub.id, { x, y });
			nodes.push({ id: hub.id, hub: true, x, y, vx: 0, vy: 0, r: 30 });
		});
	const placed = new Map<string, number>();
	for (const memory of model.memories) {
		const centre = centres.get(memory.hub) ?? { x: 0, y: 0 };
		const index = placed.get(memory.hub) ?? 0;
		placed.set(memory.hub, index + 1);
		const angle = index * GOLDEN * 2.1 + 0.4;
		const distance = 55 + 10 * Math.sqrt(index);
		nodes.push({
			id: memory.id,
			hub: false,
			x: centre.x + Math.cos(angle) * distance,
			y: centre.y + Math.sin(angle) * distance,
			vx: 0,
			vy: 0,
			r: 20,
		});
	}
	return nodes;
}

const LINK = {
	source: { distance: 58, strength: 0.25 },
	version: { distance: 60, strength: 0.25 },
	similar: { distance: 140, strength: 0.03 },
} as const;

/**
 * One step of the simulation: pairwise repulsion with collision, springs
 * along edges, a weak pull to the centre, then velocity decay. `alpha`
 * (0..1) scales the step; callers lower it over time.
 */
export function stepLayout(
	nodes: SimNode[],
	edges: readonly GraphEdge[],
	alpha: number,
) {
	const index = new Map(nodes.map((node) => [node.id, node]));
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			let d2 = dx * dx + dy * dy;
			if (d2 < 0.01) {
				dx = ((i * 7 + j * 13) % 11) / 11 - 0.45;
				dy = ((i * 5 + j * 3) % 7) / 7 - 0.45;
				d2 = dx * dx + dy * dy;
			}
			if (d2 > 360_000) continue;
			const d = Math.sqrt(d2);
			const charge = a.hub && b.hub ? 900 : 260;
			let force = (charge / d2) * alpha;
			const min = a.r + b.r;
			if (d < min) force += ((min - d) / d) * 0.5;
			const fx = dx * force;
			const fy = dy * force;
			if (!a.fixed) {
				a.vx -= fx;
				a.vy -= fy;
			}
			if (!b.fixed) {
				b.vx += fx;
				b.vy += fy;
			}
		}
	}
	for (const edge of edges) {
		const a = index.get(edge.from);
		const b = index.get(edge.to);
		if (!a || !b) continue;
		const spec = LINK[edge.kind];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const d = Math.sqrt(dx * dx + dy * dy) || 1;
		const pull =
			((d - spec.distance) / d) * spec.strength * alpha * edge.weight;
		const share = a.hub && !b.hub ? 0.15 : 0.5;
		if (!a.fixed) {
			a.vx += dx * pull * share;
			a.vy += dy * pull * share;
		}
		if (!b.fixed) {
			b.vx -= dx * pull * (1 - share);
			b.vy -= dy * pull * (1 - share);
		}
	}
	for (const node of nodes) {
		if (node.fixed) {
			node.vx = 0;
			node.vy = 0;
			continue;
		}
		node.vx -= node.x * 0.02 * alpha;
		node.vy -= node.y * 0.03 * alpha;
		node.vx *= 0.6;
		node.vy *= 0.6;
		node.x += node.vx;
		node.y += node.vy;
	}
}

/** Seeds and settles the layout: `ticks` steps with alpha falling to zero. */
export function settleLayout(model: MemoryGraphModel, ticks = 240): SimNode[] {
	const nodes = seedLayout(model);
	for (let tick = 0; tick < ticks; tick++)
		stepLayout(nodes, model.edges, 1 - tick / ticks);
	return nodes;
}

/** Bounds of a layout, padded. */
export function layoutBounds(nodes: readonly SimNode[], pad = 60) {
	if (!nodes.length) return { x: -200, y: -150, width: 400, height: 300 };
	const xs = nodes.map((node) => node.x);
	const ys = nodes.map((node) => node.y);
	const x = Math.min(...xs) - pad;
	const y = Math.min(...ys) - pad;
	return {
		x,
		y,
		width: Math.max(...xs) + pad - x,
		height: Math.max(...ys) + pad - y,
	};
}
