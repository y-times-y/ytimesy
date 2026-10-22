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
	it("opens with a one-line composer, scope chips and no Use memory switch", () => {
		const html = render();
		expect(html).toContain(
			'placeholder="Tell the agent something to remember…"',
		);
		expect(html).toContain('aria-label="Applies to Personal"');
		expect(html).toContain("Always on");
		expect(html).not.toContain("<select");
		expect(html).not.toContain("Notes (new topic)");
		expect(html).not.toContain("Use memory");
		expect(html).not.toContain('role="switch"');
		const chips = text(html.slice(html.indexOf("memory-scopes")));
		expect(chips.indexOf("Personal")).toBeLessThan(chips.indexOf("Web app"));
		expect(html).toMatch(/aria-pressed="true"[^>]*>All/);
		expect(html).not.toContain("memory-graph");
	});

	it("lists lines by topic with their marks, details and actions", () => {
		const html = render({ focus: { path: "tooling.md" } });
		expect(html).toContain('data-replaced="true"');
		expect(html).toContain("Always on</span>");
		expect(html).toContain(">Replaced</span>");
		expect(html).toContain(">Inferred</span>");
		expect(html).toContain(">Oct 2</span>");
		expect(html).toContain(`href="/?chat=${CHAT}"`);
		expect(html).toContain('aria-label="Unpin always-on rule"');
		expect(html).toContain('aria-label="Pin as always-on rule"');
		expect(html.match(/aria-label="Edit"/g)).toHaveLength(3);
		expect(html.match(/aria-label="Move"/g)).toHaveLength(3);
		expect(html.match(/aria-label="Delete"/g)).toHaveLength(4);
		expect(text(html)).not.toMatch(/\[\[tooling\]\]/);
	});

	it("keeps Dreaming to two short lines with the changes behind a toggle", () => {
		const html = render();
		const plain = text(html);
		expect(plain).toContain("Dreaming");
		expect(plain).toContain("tidies memory while you");
		expect(plain).toMatch(/Last\s+Oct 20/);
		expect(plain).toContain("1 merged, 1 replaced");
		expect(plain).toContain("after your next chat");
		expect(html).toContain('aria-expanded="false"');
		expect(plain).not.toContain("Weekly review");
		expect(plain).not.toContain("Merged the two error-format notes");
		expect(plain).not.toContain("Run now");
	});
});
