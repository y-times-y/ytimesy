import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./memory.fn", () => ({
	readMemoryFn: async () => null,
	readMemoryDreamsFn: async () => null,
	readMemoryGraphFn: async () => null,
	readMemoryHistoryFn: async () => [],
	clearMemoryFn: async () => undefined,
	editMemoryFn: async () => ({ ok: true }),
}));

const { MemoryGraphPage, MemoryGraphLegend, hexagonPath } = await import(
	"./memory-graph-page"
);

const A = "11111111-1111-4111-8111-111111111111";
const files = [
	{
		path: "api.md",
		content: `# API\n\n- Errors are problem+json [source: /?chat=${A}; added: 2026-10-20]\n- Old webhook note [superseded-by: /?chat=${A}; added: 2026-09-01]\n- Always pnpm [scope: always; kind: inferred; source: manual; added: 2026-09-02]\n`,
	},
];

function render() {
	const client = new QueryClient();
	client.setQueryData(["memory"], { available: true, mode: "full", files });
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryGraphPage active onOpenChat={() => true} />
		</QueryClientProvider>,
	);
}

describe("Memory graph page", () => {
	it("draws chat hubs and one hexagon per memory, statuses as badges", () => {
		const page = render();
		const html = page.slice(0, page.indexOf("memory-graph-legend"));
		expect(html).toContain(
			'aria-label="Memory graph: 3 memories from 3 sources"',
		);
		expect(html.match(/class="memory-hex"/g)).toHaveLength(3);
		expect(html.match(/class="memory-hub"/g)).toHaveLength(3);
		expect(html).toContain('data-status="forgotten"');
		expect(html).toContain('data-status="rule"');
		expect(html).toContain('data-inferred="true"');
		expect(html).toContain("All memory");
		expect(html).toContain("3 memories");
		expect(html).not.toContain("<select");
	});

	it("explains every mark in the legend with the same shapes", () => {
		const html = renderToStaticMarkup(
			<MemoryGraphLegend similarBasis="meaning" />,
		);
		for (const label of [
			"Chat",
			"Memory",
			"Older version",
			"New",
			"Expiring soon",
			"Retired",
			"Always on",
			"From chat",
			"Similar",
			"Newer version",
			"Weak",
			"Strong",
		])
			expect(html).toContain(label);
		expect(html).toContain('class="memory-hex-shape"');
	});

	it("rounds the hexagon's six corners", () => {
		expect(hexagonPath(15).match(/Q/g)).toHaveLength(6);
	});
});
