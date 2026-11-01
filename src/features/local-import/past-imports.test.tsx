import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("./local-import.fn", () => ({ finishedLocalImportsFn: vi.fn() }));

const { PastImportList, pastImportLine } = await import("./past-imports");

const entry = {
	id: "i1",
	finishedAt: "2026-11-01T18:00:00Z",
	agent: "claude" as const,
	sessions: 3,
	projectId: "p1",
	projectName: "app",
	sessionId: "c1",
};

it("lists each finished import with its agent, sessions, date and chat", () => {
	expect(pastImportLine(entry)).toBe("Claude Code · 3 sessions · Nov 1");
	const html = renderToStaticMarkup(
		<PastImportList
			imports={[
				entry,
				{ ...entry, id: "i2", agent: null, sessions: 1, sessionId: null },
			]}
		/>,
	);
	expect(html).toContain("app");
	expect(html).toContain('href="/?project=p1&amp;chat=c1"');
	expect(html).toContain("Local agent · 1 session · Nov 1");
	expect(html.match(/Open chat/g)).toHaveLength(1);
	expect(renderToStaticMarkup(<PastImportList imports={[]} />)).toBe("");
});
