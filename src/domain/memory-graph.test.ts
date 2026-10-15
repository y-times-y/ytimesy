import { describe, expect, it } from "vitest";
import { memoryGraph } from "./memory-graph";

describe("memory graph", () => {
	it("has a node per file, an edge per [[link]] and backlinks, inside the canvas", () => {
		const graph = memoryGraph([
			{
				path: "MEMORY.md",
				content: "## Index\n- [[tooling]]\n- [[people/priya]]\n- [[missing]]",
			},
			{ path: "tooling.md", content: "- Uses pnpm; see [[people/priya]]" },
			{ path: "people/priya.md", content: "- Owns pricing" },
		]);
		expect(graph.edges).toEqual([
			{ from: "MEMORY.md", to: "tooling.md" },
			{ from: "MEMORY.md", to: "people/priya.md" },
			{ from: "tooling.md", to: "people/priya.md" },
		]);
		const priya = graph.nodes.find((node) => node.path === "people/priya.md");
		expect(priya?.backlinks).toEqual(["MEMORY.md", "tooling.md"]);
		expect(graph.nodes.find((node) => node.root)?.path).toBe("MEMORY.md");
		for (const node of graph.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(20);
			expect(node.x).toBeLessThanOrEqual(580);
			expect(node.y).toBeGreaterThanOrEqual(20);
			expect(node.y).toBeLessThanOrEqual(400);
		}
		const [a, b] = graph.nodes;
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
	});
});
