import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./memory.fn", () => ({
	readMemoryFn: async () => null,
	readMemoryDreamsFn: async () => null,
	readMemoryGraphFn: async () => ({ dreams: [] }),
	readMemoryHistoryFn: async () => [],
	clearMemoryFn: async () => undefined,
	editMemoryFn: async () => ({ ok: true }),
}));

const { MemoryGraphPage, MemoryLanesLegend } = await import(
	"./memory-graph-page"
);

const A = "11111111-1111-4111-8111-111111111111";
const files = [
	{
		path: "api.md",
		content: `# API\n\n- Errors are problem+json [project: acme/web; source: /?chat=${A}; added: 2026-10-20]\n- Old webhook note [superseded-by: /?chat=${A}; added: 2026-09-01]\n- Always pnpm [scope: always; kind: inferred; source: manual; added: 2026-09-02]\n`,
	},
];

function render() {
	const client = new QueryClient();
	client.setQueryData(["memory"], { available: true, mode: "full", files });
	client.setQueryData(["memory-lanes", files], {
		dreams: [
			{
				at: "2026-10-19T03:00:00Z",
				message: "Merged notes",
				merges: [
					{
						into: "Errors are problem+json",
						from: [
							{
								text: "Errors are JSON",
								added: "2026-10-03",
								project: "acme/web",
							},
						],
					},
				],
			},
		],
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryGraphPage active onOpenChat={() => true} />
		</QueryClientProvider>,
	);
}

describe("Memory lanes page", () => {
	it("draws one lane per scope with a mark per line, a dream and its merge", () => {
		const html = render();
		expect(html).toContain('aria-label="Memory lanes: 2 memories in 2 scopes"');
		expect(html.match(/data-node="/g)).toHaveLength(3);
		expect(html).toContain('data-retired="true"');
		expect(html).toContain('data-mark="rule"');
		// Merged lines converge into the line they became; no extra merge glyph.
		expect(html.match(/class="lane-merge-line"/g)).toHaveLength(1);
		expect(html).toContain(">Dream</text>");
		expect(html).not.toContain('lane-merge"');
		expect(html).toContain('class="lane-rule"');
		expect(html).toContain(">Today<");
		const labels = html.slice(html.indexOf("lane-labels"));
		expect(labels.indexOf("Personal")).toBeLessThan(labels.indexOf("web"));
		expect(html).not.toContain("<select");
		expect(html).not.toContain("hex");
	});

	it("explains the marks in one short legend line", () => {
		const html = renderToStaticMarkup(<MemoryLanesLegend />);
		for (const label of [
			"Inferred",
			"New this week",
			"Always on",
			"Replaced by",
		])
			expect(html).toContain(label);
		expect(html.match(/<li>/g)).toHaveLength(4);
	});
});
