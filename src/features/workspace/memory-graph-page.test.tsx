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

const { MemoryGraphPage, MemoryBlocksKey } = await import(
	"./memory-graph-page"
);

const A = "11111111-1111-4111-8111-111111111111";
const files = [
	{
		path: "api.md",
		content: `# API\n\n- Errors are problem+json [project: acme/web; source: /?chat=${A}; added: 2026-10-20]\n- Old webhook note [superseded-by: /?chat=${A}; project: acme/web; added: 2026-09-01]\n- Always pnpm [scope: always; kind: inferred; source: manual; added: 2026-09-02]\n`,
	},
];

function render(memoryFiles = files) {
	const client = new QueryClient();
	client.setQueryData(["memory"], {
		available: true,
		mode: "full",
		files: memoryFiles,
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryGraphPage active onOpenChat={() => true} />
		</QueryClientProvider>,
	);
}

describe("Memory graph page", () => {
	it("draws one block of squares per space in its final place", () => {
		const html = render();
		expect(html).toContain(
			'aria-label="Memory blocks: 3 memories in 2 spaces"',
		);
		expect(html.match(/class="memory-block"/g)).toHaveLength(2);
		expect(html.match(/class="memory-cell"/g)).toHaveLength(3);
		expect(html).toContain('data-mark="pinned"');
		expect(html).toContain('data-mark="inferred"');
		expect(html).toContain('data-mark="archived"');
		// Laid out by the data alone: no view transform before any gesture.
		expect(html).toContain('<div class="memory-blocks-world">');
		expect(html).toContain("1 active");
	});

	it("filters by space and New with chips, never a native select", () => {
		const html = render();
		const chips = html.slice(
			html.indexOf("memory-blocks-chips"),
			html.indexOf("memory-blocks-stage"),
		);
		for (const label of [">All<", ">web<", ">Personal<", ">New<"])
			expect(chips).toContain(label);
		expect(html).not.toContain("<select");
	});

	it("keeps none of the old graph's marks", () => {
		const html = render();
		for (const gone of [
			"memory-hex",
			"memory-hub",
			"memory-graph-edges",
			"Expiring soon",
			"Similar",
		])
			expect(html).not.toContain(gone);
	});

	it("says so when there is no memory", () => {
		const html = render([]);
		expect(html).toContain("No memory yet.");
		expect(html).not.toContain("memory-blocks-chips");
	});

	it("keeps the memory on screen when a refetch after an edit fails", () => {
		const client = new QueryClient();
		client.setQueryData(["memory"], { available: true, mode: "full", files });
		client
			.getQueryCache()
			.find({ queryKey: ["memory"] })
			?.setState({ status: "error", error: new Error("Network lost") });
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<MemoryGraphPage active onOpenChat={() => true} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Memory blocks: 3 memories");
		expect(html).not.toContain("unavailable");
	});

	it("offers a retry, not 'unavailable', when the first read fails", () => {
		const client = new QueryClient();
		// As after its retries: the failed read stays failed on render.
		client.setQueryDefaults(["memory"], { retryOnMount: false });
		client
			.getQueryCache()
			.build(client, { queryKey: ["memory"] })
			.setState({
				status: "error",
				error: new Error("Repository not found"),
			});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<MemoryGraphPage active onOpenChat={() => true} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Couldn&#x27;t load memory.");
		expect(html).toContain(">Retry<");
		expect(html).not.toContain("unavailable");
	});

	it("explains every mark in the key with the same mark", () => {
		const html = renderToStaticMarkup(<MemoryBlocksKey hatch="h" />);
		for (const label of ["Pinned", "Memory", "Inferred", "Archived", "New"])
			expect(html).toContain(label);
		expect(html).toContain("Older");
		expect(html).toContain("Newer");
	});
});
