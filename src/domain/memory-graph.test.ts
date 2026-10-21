import { describe, expect, it } from "vitest";
import { memoryGraph, nodeRadius, packCircles } from "./memory-graph";
import { memoryRows, memoryScopes, topicTitles } from "./memory-overview";

const CHAT = "22222222-2222-4222-8222-222222222222";
const files = {
	"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n- [[api]]\n",
	"tooling.md": `# Tooling\n\n- Use pnpm, never npm [scope: always; source: /?chat=${CHAT}; added: 2026-10-20]\n- Uses Vitest, see [[api]] [kind: inferred; added: 2026-09-01]\n- Old [superseded-by: x; added: 2026-09-01]\n`,
	"api.md": `# API\n\n- Errors are problem+json [project: acme/web; source: /?chat=${CHAT}; added: 2026-10-16]\n- Cursor pagination [project: acme/web; added: 2026-10-01]\n`,
};
const today = "2026-10-21";

function build() {
	const rows = memoryRows(files, today);
	return memoryGraph({
		rows,
		scopes: memoryScopes(rows),
		titles: topicTitles(files),
		scopeTitle: (scope) => scope.project ?? "Personal",
		today,
	});
}

describe("memory map", () => {
	it("draws one cluster per scope with its topics, and one node per line in use", () => {
		const graph = build();
		expect(
			graph.clusters.map((cluster) => [cluster.title, cluster.count]),
		).toEqual([
			["Personal", 2],
			["acme/web", 2],
		]);
		expect(graph.clusters[1].topics.map((topic) => topic.title)).toEqual([
			"API",
		]);
		// Index links and replaced lines are not memories on the map.
		expect(graph.nodes.map((node) => node.row.text).sort()).toEqual([
			"Cursor pagination",
			"Errors are problem+json",
			"Use pnpm, never npm",
			"Uses Vitest, see [[api]]",
		]);
	});

	it("keeps every node inside its topic, topics inside their cluster, and clusters apart", () => {
		const graph = build();
		for (const cluster of graph.clusters)
			for (const topic of cluster.topics) {
				expect(
					Math.hypot(topic.x - cluster.x, topic.y - cluster.y) + topic.r,
				).toBeLessThanOrEqual(cluster.r + 0.01);
				for (const node of graph.nodes.filter((n) => n.topic === topic.id))
					expect(Math.hypot(node.x - topic.x, node.y - topic.y)).toBeLessThan(
						topic.r,
					);
			}
		const [a, b] = graph.clusters;
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
	});

	it("joins lines from one chat and a line to the topic it links", () => {
		const graph = build();
		expect(
			graph.edges.map((edge) => [edge.kind, edge.from, edge.to]).sort(),
		).toEqual([
			["chat", "tooling.md:3", "api.md:3"],
			["link", "tooling.md:4", "project:acme/web|api.md"],
		]);
	});

	it("sizes nodes by recency and marks this week's lines", () => {
		expect(nodeRadius({ added: "2026-10-20" }, today)).toBeGreaterThan(
			nodeRadius({ added: "2026-10-01" }, today),
		);
		expect(nodeRadius({ added: "2026-10-01" }, today)).toBeGreaterThan(
			nodeRadius({}, today),
		);
		const recent = build().nodes.filter((node) => node.recent);
		expect(recent.map((node) => node.row.text)).toEqual([
			"Use pnpm, never npm",
			"Errors are problem+json",
		]);
	});

	it("packs circles without overlap, deterministically, and fast enough for hundreds of lines", () => {
		const radii = Array.from({ length: 12 }, (_, i) => 10 + (i % 4) * 6);
		const packed = packCircles(radii, { gap: 4 });
		for (let i = 0; i < packed.length; i++)
			for (let j = i + 1; j < packed.length; j++)
				expect(
					Math.hypot(packed[i].x - packed[j].x, packed[i].y - packed[j].y),
				).toBeGreaterThan(packed[i].r + packed[j].r);
		expect(packCircles(radii, { gap: 4 })).toEqual(packed);

		const many: Record<string, string> = {};
		for (let t = 0; t < 12; t++)
			many[`t${t}.md`] = `# T${t}\n${Array.from(
				{ length: 30 },
				(_, i) =>
					`- Line ${t}-${i} [${i % 3 ? "" : `project: p${t % 4}; `}added: 2026-10-${String((i % 20) + 1).padStart(2, "0")}]`,
			).join("\n")}\n`;
		const rows = memoryRows(many, today);
		const started = performance.now();
		const graph = memoryGraph({
			rows,
			scopes: memoryScopes(rows),
			titles: topicTitles(many),
			scopeTitle: (scope) => scope.project ?? "Personal",
			today,
		});
		expect(graph.nodes).toHaveLength(360);
		expect(performance.now() - started).toBeLessThan(250);
	});
});
