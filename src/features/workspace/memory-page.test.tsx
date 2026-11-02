import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./memory.fn", () => ({
	readMemoryFn: async () => null,
	readMemoryDreamsFn: async () => null,
	readMemoryHistoryFn: async () => [],
	clearMemoryFn: async () => undefined,
	editMemoryFn: async () => ({ ok: true }),
}));

const { MemoryPage } = await import("./memory-page");

const CHAT = "11111111-1111-4111-8111-111111111111";
const WEB = "projects/acme-web--7";
const files = [
	{
		path: "MEMORY.md",
		content: `# Memory\n\n## Index\n- [[personal/style]]\n- [[${WEB}/api]]\n`,
	},
	{
		path: "personal/style.md",
		content: "# Style\n\n- Prefers short replies [added: 2026-10-20]\n",
	},
	{
		path: `${WEB}/api.md`,
		content: `# API\n\n- Errors are problem+json [scope: always; source: /?chat=${CHAT}; added: 2026-10-21]\n- Old webhook note [superseded-by: /?chat=${CHAT}; added: 2026-09-01]\n`,
	},
	{
		path: "projects/old-tool--9/notes.md",
		content: "# Notes\n\n- Uses make [added: 2026-08-01]\n",
	},
];
const projects = [
	{
		id: "p1",
		name: "Website",
		fullName: "acme/web",
		repositoryId: 7,
		installationId: 1,
		branch: "main",
	},
];

function render(view: "tree" | "list") {
	const client = new QueryClient();
	client.setQueryData(["memory"], { available: true, mode: "full", files });
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryPage
				view={view}
				projects={projects}
				onViewChange={() => {}}
				onOpenChat={() => true}
			/>
		</QueryClientProvider>,
	);
}

/** Pictographs and other emoji: the page is plain text and lucide icons only. */
const EMOJI = /\p{Extended_Pictographic}/u;

describe("Memory page", () => {
	it("shows the repo's folder tree by default: Personal, then each project by name", () => {
		const html = render("tree");
		expect(html).toContain("<h1>Memory</h1>");
		expect(html).toMatch(/aria-pressed="true"[^>]*>Folders</);
		expect(html).toMatch(/aria-pressed="false"[^>]*>List</);
		const folders = [
			...html.matchAll(/<details class="memory-folder" open="">/g),
		];
		expect(folders).toHaveLength(3);
		// Personal first, then projects: the known one by its name, an unknown folder by its slug.
		const personal = html.indexOf("Personal");
		const website = html.indexOf("Website");
		const old = html.indexOf("old-tool");
		expect(personal).toBeGreaterThan(-1);
		expect(website).toBeGreaterThan(personal);
		expect(old).toBeGreaterThan(-1);
		expect(html).not.toContain("acme-web--7</");
		// Topic files, then their notes with date, source chat and the always badge.
		expect(html).toContain('data-topic="personal/style.md"');
		expect(html).toContain(`data-topic="${WEB}/api.md"`);
		expect(html).toContain("Errors are problem+json");
		expect(html).toContain('<span class="memory-badge">Always on</span>');
		expect(html).toContain(`href="/?chat=${CHAT}"`);
		expect(html).toContain("Oct 21");
		expect(html).toContain('data-replaced="true"');
		// Folder details sit behind tooltips; no chips or order switch in the tree.
		expect(html).toContain('title="Used in every project"');
		expect(html).toContain('title="Used only in Website"');
		expect(html).not.toContain('aria-label="Order lines"');
		expect(html).not.toContain("<select");
		expect(html).not.toMatch(EMOJI);
	});

	it("shows the list in the same page", () => {
		const html = render("list");
		expect(html).toMatch(/aria-pressed="true"[^>]*>List</);
		expect(html).toContain("memory-inspector");
		expect(html).toContain('aria-label="Order lines"');
		expect(html).not.toContain('class="memory-folder"');
	});
});
