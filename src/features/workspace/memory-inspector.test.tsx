import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryDreamStatus } from "#/domain/memory-dream-schedule";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./memory.fn", () => ({
	readMemoryFn: async () => null,
	readMemoryDreamsFn: async () => null,
	readMemoryHistoryFn: async () => [],
	saveMemoryModeFn: async () => undefined,
	clearMemoryFn: async () => undefined,
	editMemoryFn: async () => ({ ok: true }),
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
		content:
			"# API\n\n- Errors are problem+json [project: acme/web-app; added: 2026-10-16]\n",
	},
];
const dreams: MemoryDreamStatus = {
	next: { kind: "after-next-chat" },
	reviewDue: "2099-10-25T03:00:00.000Z",
	lastRunAt: "2026-10-20T22:10:00.000Z",
	lastReviewAt: "2026-10-18T03:00:00.000Z",
	lastChange: {
		at: "2026-10-20T22:10:00.000Z",
		message: "Merged the two error-format notes",
		summary: {
			added: [],
			merged: [{ into: "Errors are problem+json", from: ["Errors are JSON"] }],
			expired: [],
			resolved: ["Use npm for installs"],
			removed: [],
		},
	},
};

function render(
	options: { focus?: { path: string }; mode?: "off" | "full" } = {},
) {
	const client = new QueryClient();
	client.setQueryData(["memory"], {
		available: true,
		mode: options.mode ?? "full",
		files,
	});
	client.setQueryData(["memory-dreams"], dreams);
	client.setQueryData(
		["projects"],
		[{ id: "p1", fullName: "acme/web-app", name: "Web app" }],
	);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryInspector
				active
				focus={options.focus}
				onOpenChat={() => true}
				layout="page"
			/>
		</QueryClientProvider>,
	);
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("Memory view", () => {
	it("shows Personal and each project as scopes, the map beside the list, and an Add button", () => {
		const html = render();
		const chips = text(html.slice(html.indexOf("memory-scopes")));
		expect(chips.indexOf("Personal")).toBeLessThan(chips.indexOf("Web app"));
		expect(html).toMatch(/aria-pressed="true"[^>]*>All/);
		expect(html).toContain('class="memory-map-svg"');
		expect(html).toContain('aria-label="Memory map: 3 memories in 2 scopes"');
		// Stated, inferred and always-on lines are drawn differently.
		expect(html).toContain('data-kind="rule"');
		expect(html).toContain('data-kind="inferred"');
		expect(html).toContain('data-kind="stated"');
		expect(html).toContain("Add memory");
		expect(html).toContain('aria-label="Search memory"');
	});

	it("replaces the on/off button with a Use memory switch and what off means", () => {
		const html = render({ mode: "off" });
		expect(html).not.toContain("Memory on");
		expect(html).not.toContain("Memory off");
		expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
		expect(html).toContain(">Use memory</label>");
		expect(html).toContain(
			"When off, nothing is recalled into chats and nothing new is saved.",
		);
		expect(render()).toMatch(/role="switch"[^>]*aria-checked="true"/);
	});

	it("lists lines by topic with their marks, details and edit actions", () => {
		const html = render({ focus: { path: "tooling.md" } });
		expect(html).toContain('data-replaced="true"');
		expect(html).toContain("Always on</span>");
		expect(html).toContain(">Replaced</span>");
		expect(html).toContain(">Inferred</span>");
		expect(html).toContain(">Oct 2</span>");
		expect(html).toContain(`href="/?chat=${CHAT}"`);
		expect(html).toContain('aria-label="Unpin always-on rule"');
		expect(html).toContain('aria-label="Pin as always-on rule"');
		// Edit or move on every line in use; delete on every line.
		expect(html.match(/aria-label="Edit or move"/g)).toHaveLength(3);
		expect(html.match(/aria-label="Delete"/g)).toHaveLength(4);
		// No undo, and the index's topic links are not memories.
		expect(html).not.toContain(">Undo<");
		expect(text(html)).not.toMatch(/\[\[tooling\]\]/);
	});

	it("shows when dreaming last ran, when it runs next, and what it last changed", () => {
		const html = text(render());
		expect(html).toContain("Dreaming");
		expect(html).toContain("Last run");
		expect(html).toContain("After your next chat goes quiet");
		expect(html).toContain("Next due");
		expect(html).toContain("Merged the two error-format notes");
		expect(html).toContain("1 merge");
		expect(html).toContain("1 conflict resolved");
		expect(html).not.toContain("Run now");
	});
});
