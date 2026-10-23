import { describe, expect, it } from "vitest";
import {
	MANUAL_HUB,
	memoryGraphModel,
	settleLayout,
	similarPairs,
	UNKNOWN_HUB,
	wordSimilarPairs,
} from "./memory-graph";
import { memoryRows } from "./memory-overview";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const files = {
	"MEMORY.md": "# Memory\n\n## Index\n- [[api]]\n",
	"api.md": `# API\n\n- New webhook events go to v1 [superseded-by: /?chat=${B}; source: /?chat=${A}; added: 2026-10-01]\n- Errors are problem+json [project: acme/web; source: /?chat=${A}; added: 2026-10-16]\n- New webhook events go to v2 only [source: /?chat=${B}; added: 2026-10-18]\n- Beta flag stays on [expires: 2026-10-28; source: manual; added: 2026-09-01]\n- Uses tabs\n`,
};
const today = "2026-10-21";
const rows = memoryRows(files, today);

describe("memory graph model", () => {
	it("hangs each memory off its source chat, manual lines off Added by you", () => {
		const model = memoryGraphModel({
			rows,
			today,
			scope: null,
			chatTitles: { [A]: "Webhook design" },
		});
		expect(model.hubs.map((hub) => [hub.id, hub.label, hub.count])).toEqual([
			[`hub:${A}`, "Webhook design", 2],
			[`hub:${B}`, "Chat", 1],
			[MANUAL_HUB, "Added by you", 1],
			[UNKNOWN_HUB, "Earlier memory", 1],
		]);
		expect(model.memories).toHaveLength(5);
		expect(model.edges.filter((edge) => edge.kind === "source")).toHaveLength(
			5,
		);
	});

	it("chains a replaced line to the line that replaced it, with versions", () => {
		const model = memoryGraphModel({ rows, today, scope: null });
		const version = model.edges.filter((edge) => edge.kind === "version");
		expect(version.map((edge) => [edge.from, edge.to])).toEqual([
			["api.md:3", "api.md:5"],
		]);
		const byText = (text: string) =>
			model.memories.find((memory) => memory.row.text.startsWith(text));
		expect(byText("New webhook events go to v1")).toMatchObject({
			version: 1,
			versions: 2,
			forgotten: true,
		});
		expect(byText("New webhook events go to v2")).toMatchObject({
			version: 2,
			versions: 2,
			recent: true,
		});
		expect(byText("Beta flag")).toMatchObject({
			expiring: true,
			recent: false,
		});
	});

	it("filters to one scope and keeps only its hubs", () => {
		const model = memoryGraphModel({ rows, today, scope: "project:acme/web" });
		expect(model.memories.map((memory) => memory.row.text)).toEqual([
			"Errors are problem+json",
		]);
		expect(model.hubs).toHaveLength(1);
	});

	it("pairs similar lines by vectors, or by shared words without them", () => {
		const pairs = similarPairs(
			["a", "b", "c"],
			[
				[1, 0],
				[0.9, 0.1],
				[0, 1],
			],
			{ min: 0.8 },
		);
		expect(pairs.map((pair) => [pair.a, pair.b])).toEqual([["a", "b"]]);
		expect(pairs[0].score).toBeGreaterThan(0.99);
		expect(
			wordSimilarPairs(rows).map((pair) => [pair.a, pair.b]),
		).toContainEqual(["api.md:3", "api.md:5"]);
	});

	it("settles hubs apart with each memory near its hub, deterministically", () => {
		const model = memoryGraphModel({ rows, today, scope: null });
		const layout = settleLayout(model);
		expect(settleLayout(model)).toEqual(layout);
		const at = new Map(layout.map((node) => [node.id, node]));
		for (const memory of model.memories) {
			const node = at.get(memory.id);
			const hub = at.get(memory.hub);
			if (!node || !hub) throw new Error("missing node");
			expect(Math.hypot(node.x - hub.x, node.y - hub.y)).toBeLessThan(220);
		}
		for (const a of layout)
			for (const b of layout)
				if (a !== b)
					expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20);
	});

	it("lays out a few hundred memories quickly", () => {
		const big: Record<string, string> = {};
		for (let t = 0; t < 10; t++)
			big[`t${t}.md`] = Array.from(
				{ length: 30 },
				(_, i) =>
					`- Line ${t} ${i} [source: /?chat=33333333-3333-4333-8333-${String(100000000000 + ((t * 30 + i) % 25))}; added: 2026-10-01]`,
			).join("\n");
		const model = memoryGraphModel({
			rows: memoryRows(big, today),
			today,
			scope: null,
		});
		const started = performance.now();
		settleLayout(model);
		expect(model.memories).toHaveLength(300);
		expect(performance.now() - started).toBeLessThan(2500);
	});
});
