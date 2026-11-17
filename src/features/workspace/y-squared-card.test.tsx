import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { YOverviewThread } from "#/domain/y-overview";

vi.mock("../sessions/agent-session.fn", () => ({
	listProjectAgentSessions: async () => [],
	readYSquaredCrewCard: async () => [],
}));

const { YSquaredCard } = await import("./y-squared-card");
const { cardSignature } = await import("#/domain/y-squared-card");

const PROJECT = "project-1";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");

const chats: YOverviewThread[] = [
	{ id: "y2", title: "Y²", role: "y2", turnStatus: "completed" },
	{
		id: "ask",
		title: "Billing page",
		turnStatus: "completed",
		waitingOn: "plan",
		updatedAt: "2026-11-12T11:57:00.000Z",
	},
	{
		id: "run",
		title: "Fix flaky login test",
		turnStatus: "running",
		workingSince: "2026-11-12T11:52:00.000Z",
		updatedAt: "2026-11-12T11:59:59.000Z",
	},
	{
		id: "done",
		title: "Docs",
		turnStatus: "completed",
		updatedAt: "2026-11-12T11:30:00.000Z",
	},
];

function render(listed: readonly YOverviewThread[]) {
	const client = new QueryClient();
	client.setQueryData(["agent-sessions", PROJECT], listed);
	client.setQueryData(
		["y-squared-crew-card", PROJECT, cardSignature(listed)],
		[
			{
				sessionId: "run",
				lastRequest: "Fix the flaky login test",
				prUrl: "https://github.com/acme/web/pull/12",
			},
		],
	);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<YSquaredCard
				projectId={PROJECT}
				renderedAtMs={NOW}
				onOpenThread={() => {}}
			/>
		</QueryClientProvider>,
	);
}

describe("YSquaredCard markup", () => {
	const html = render(chats);

	it("lists the groups in order: waiting on you, in progress, done recently", () => {
		const waiting = html.indexOf("Waiting on you");
		const progress = html.indexOf("In progress");
		const done = html.indexOf("Done recently");
		expect(waiting).toBeGreaterThan(-1);
		expect(progress).toBeGreaterThan(waiting);
		expect(done).toBeGreaterThan(progress);
	});

	it("shows each thread's title, what it waits on, request, elapsed time and PR link", () => {
		expect(html).toContain("Billing page");
		expect(html).toContain("waiting on your plan approval");
		expect(html).toContain("Fix flaky login test");
		expect(html).toContain("Fix the flaky login test");
		// 8 minutes since the start, as of the server's render time
		expect(html).toMatch(/<time[^>]*>8:00<\/time>/);
		expect(html).toContain('href="https://github.com/acme/web/pull/12"');
		expect(html).not.toContain("Y²</span>");
	});

	it("renders nothing when there are no threads", () => {
		expect(render([{ id: "y2", title: "Y²", role: "y2" }])).toBe("");
	});
});
