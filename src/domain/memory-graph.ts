import { MEMORY_ENTRY, memoryLinks } from "./memory-repo";

/**
 * The memory repo as an Obsidian-style graph: files are nodes, `[[links]]`
 * are edges, MEMORY.md is the root. The layout is a small deterministic
 * force simulation (repulsion, link springs, centering), the same shape as
 * Quartz's d3-force graph, computed once per repo state.
 */
export type MemoryGraphNode = {
	path: string;
	root: boolean;
	/** Distinct files linking here. */
	backlinks: string[];
	lines: number;
	x: number;
	y: number;
};
export type MemoryGraph = {
	nodes: MemoryGraphNode[];
	edges: { from: string; to: string }[];
};

export function memoryGraph(
	files: readonly { path: string; content: string }[],
	size = { width: 600, height: 420 },
): MemoryGraph {
	const known = new Set(files.map((file) => file.path));
	const edges = files.flatMap((file) =>
		[...new Set(memoryLinks(file.content))]
			.filter((target) => known.has(target) && target !== file.path)
			.map((target) => ({ from: file.path, to: target })),
	);
	const count = files.length;
	const nodes: MemoryGraphNode[] = files.map((file, index) => {
		const angle = (2 * Math.PI * index) / Math.max(count, 1);
		const radius =
			file.path === MEMORY_ENTRY ? 0 : Math.min(size.width, size.height) / 3;
		return {
			path: file.path,
			root: file.path === MEMORY_ENTRY,
			backlinks: [
				...new Set(
					edges
						.filter((edge) => edge.to === file.path)
						.map((edge) => edge.from),
				),
			],
			lines: file.content.split("\n").length,
			x: size.width / 2 + radius * Math.cos(angle),
			y: size.height / 2 + radius * Math.sin(angle),
		};
	});
	const byPath = new Map(nodes.map((node) => [node.path, node]));
	for (let tick = 0; tick < 200; tick++) {
		const cooling = 1 - tick / 200;
		const force = new Map(nodes.map((node) => [node.path, { x: 0, y: 0 }]));
		for (let a = 0; a < nodes.length; a++)
			for (let b = a + 1; b < nodes.length; b++) {
				const dx = nodes[a].x - nodes[b].x || 0.01;
				const dy = nodes[a].y - nodes[b].y || 0.01;
				const distance2 = Math.max(dx * dx + dy * dy, 100);
				const push = 14000 / distance2;
				const distance = Math.sqrt(distance2);
				const fa = force.get(nodes[a].path);
				const fb = force.get(nodes[b].path);
				if (!fa || !fb) continue;
				fa.x += (dx / distance) * push;
				fa.y += (dy / distance) * push;
				fb.x -= (dx / distance) * push;
				fb.y -= (dy / distance) * push;
			}
		for (const edge of edges) {
			const from = byPath.get(edge.from);
			const to = byPath.get(edge.to);
			if (!from || !to) continue;
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const distance = Math.sqrt(dx * dx + dy * dy) || 1;
			const pull = (distance - 140) * 0.04;
			const ff = force.get(from.path);
			const ft = force.get(to.path);
			if (!ff || !ft) continue;
			ff.x += (dx / distance) * pull;
			ff.y += (dy / distance) * pull;
			ft.x -= (dx / distance) * pull;
			ft.y -= (dy / distance) * pull;
		}
		for (const node of nodes) {
			const f = force.get(node.path);
			if (!f) continue;
			f.x += (size.width / 2 - node.x) * 0.01;
			f.y += (size.height / 2 - node.y) * 0.01;
			const step = Math.min(Math.hypot(f.x, f.y), 30 * cooling);
			const length = Math.hypot(f.x, f.y) || 1;
			node.x = Math.min(
				size.width - 20,
				Math.max(20, node.x + (f.x / length) * step),
			);
			node.y = Math.min(
				size.height - 20,
				Math.max(20, node.y + (f.y / length) * step),
			);
		}
	}
	return { nodes, edges };
}
