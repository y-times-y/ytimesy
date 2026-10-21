import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./memory.fn", () => ({
	readMemoryFn: async () => null,
	readMemoryHistoryFn: async () => [],
	saveMemoryModeFn: async () => undefined,
	clearMemoryFn: async () => undefined,
	undoMemoryLineFn: async () => ({ removed: true }),
}));

const { MemoryInspector } = await import("./memory-inspector");

const CHAT = "22222222-2222-4222-8222-222222222222";
const files = [
	{ path: "MEMORY.md", content: "# Memory\n\n## Index\n- [[tooling]]\n" },
	{
		path: "tooling.md",
		content: `# Tooling\n\n- Use pnpm, never npm [scope: always; source: /?chat=${CHAT}; added: 2026-10-02]\n- Uses Vitest [kind: inferred; added: 2026-10-12]\n- Use npm for installs [superseded-by: /?chat=${CHAT}; added: 2026-09-01]\n`,
	},
	{
		path: "api.md",
		content: "# API\n\n- Errors are problem+json [added: 2026-10-16]\n",
	},
];

function render(focus?: { path: string }) {
	const client = new QueryClient();
	client.setQueryData(["memory"], { available: true, mode: "full", files });
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryInspector
				active
				focus={focus}
				onOpenChat={() => true}
				layout="page"
			/>
		</QueryClientProvider>,
	);
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("Memory view", () => {
	it("opens on the recent feed beside topics with the project rules pinned first, and no graph", () => {
		const html = render();
		expect(html).not.toContain('<svg class="memory-graph');
		expect(html).toContain('aria-label="Search memory"');
		const topics = text(html.slice(html.indexOf("memory-topics")));
		expect(topics.indexOf("Recently added")).toBeLessThan(
			topics.indexOf("Project rules"),
		);
		expect(topics.indexOf("Project rules")).toBeLessThan(topics.indexOf("API"));
		expect(html).toMatch(/aria-pressed="true"[^>]*>.*Recently added/);
		// Newest first, each naming its topic.
		const feed = text(html.slice(html.indexOf("memory-panel")));
		expect(feed.indexOf("problem+json")).toBeLessThan(feed.indexOf("Vitest"));
		expect(feed).toContain("tooling");
	});

	it("shows a topic's lines as rows with rule and replaced marks, kind, date and actions", () => {
		const html = render({ path: "tooling.md" });
		expect(html).toContain('data-replaced="true"');
		expect(html).toContain(">Rule</span>");
		expect(html).toContain(">Replaced</span>");
		expect(html).toContain(">inferred</span>");
		expect(html).toContain(">Oct 2</span>");
		expect(html).toContain(`href="/?chat=${CHAT}"`);
		expect(html).toContain(">Open chat</a>");
		// The replaced line has no Undo; the two in use do.
		expect(html.match(/>Undo</g)).toHaveLength(2);
	});
});
