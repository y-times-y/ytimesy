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

const { MemoryPage } = await import("./memory-page");

const files = [
	{
		path: "api.md",
		content: "# API\n\n- Errors are problem+json [added: 2026-10-20]\n",
	},
];

function render(view: "graph" | "list") {
	const client = new QueryClient();
	client.setQueryData(["memory"], { available: true, mode: "full", files });
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryPage view={view} onViewChange={() => {}} onOpenChat={() => true} />
		</QueryClientProvider>,
	);
}

describe("Memory page", () => {
	it("shows the graph with a Graph | List switch", () => {
		const html = render("graph");
		expect(html).toContain("<h1>Memory</h1>");
		expect(html).toMatch(/aria-pressed="true"[^>]*>Graph</);
		expect(html).toMatch(/aria-pressed="false"[^>]*>List</);
		// The graph renders on the server too, in its final layout.
		expect(html).toContain('class="memory-graph-page"');
		expect(html).toContain('class="memory-block"');
		expect(html).not.toContain("memory-inspector");
	});

	it("shows the list in the same page", () => {
		const html = render("list");
		expect(html).toMatch(/aria-pressed="true"[^>]*>List</);
		expect(html).toContain("memory-inspector");
		expect(html).not.toContain('class="memory-graph-page"');
	});
});
