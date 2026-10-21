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

const { MemoryGraphPage } = await import("./memory-graph-page");

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

describe("Memory history page", () => {
	it("lists one readable row per memory, newest first, with a dream divider and its merge", () => {
		const html = render();
		expect(html).toContain('aria-label="2 memories in 2 scopes"');
		expect(html.match(/data-row="/g)).toHaveLength(4);
		const order = [
			"Errors are problem+json",
			"Dream · Oct 19 · 1 merged",
			"Errors are JSON",
			"Always pnpm",
			"Old webhook note",
		].map((text) => html.indexOf(text));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// Replaced rows fade; the merge branches in; always on is a text tag.
		expect(html).toContain('data-retired="true"');
		expect(html.match(/history-branch/g)).toHaveLength(1);
		expect(html).toContain('class="history-tag">Always on<');
		expect(html).toContain(">Inferred<");
		expect(html).not.toContain("Zoom");
		expect(html).not.toContain("Today");
		expect(html).not.toContain("<select");
	});
});
