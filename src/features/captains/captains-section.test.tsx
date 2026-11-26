import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CAPTAIN_COLORS, type Captain } from "#/domain/captain";
import { CaptainsSection } from "./captains-section";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const captain = (patch: Partial<Captain>): Captain => ({
	id: "c1",
	projectId: "p1",
	chatId: "chat-1",
	name: "seo",
	label: null,
	color: CAPTAIN_COLORS[0],
	rolePrompt: "",
	position: 0,
	lastLine: null,
	lastAt: null,
	createdAt: "2026-11-26T09:00:00Z",
	turnStatus: "idle",
	needsYou: false,
	...patch,
});
function render(
	captains: Captain[] | undefined,
	props: { selectedChatId?: string; leaderName?: string | null } = {},
) {
	const client = new QueryClient();
	if (captains) client.setQueryData(["captains", "p1"], captains);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<CaptainsSection
				project={{ id: "p1", ySquaredId: "y2", leaderName: props.leaderName }}
				selectedChatId={props.selectedChatId}
				nowMs={NOW}
				onSelectChat={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

describe("CaptainsSection", () => {
	it("shows the leader first, the New captain and menu buttons, and the empty state with no captains", () => {
		const html = render([]);
		expect(html).toContain("Captains");
		expect(html).toContain('aria-label="New captain"');
		expect(html).toContain('aria-label="Captains menu"');
		expect(html).toContain("Super agent");
		expect(html).toContain("leader");
		expect(html).toContain("Give your Super agent a team");
		expect(html).toContain("cost nothing");
	});

	it("names the leader what the person called it", () => {
		expect(render([], { leaderName: "otto" })).toContain("otto");
	});

	it("lists captains with status, last line and age, grouped by label", () => {
		const html = render([
			captain({
				id: "a",
				name: "apm",
				chatId: "ca",
				turnStatus: "running",
				position: 0,
			}),
			captain({
				id: "b",
				name: "seo",
				chatId: "cb",
				label: "content",
				lastLine: "Found 6 pages missing meta",
				lastAt: "2026-11-26T10:00:00Z",
				position: 1,
			}),
			captain({
				id: "c",
				name: "newsletter",
				chatId: "cc",
				label: "content",
				needsYou: true,
				position: 2,
			}),
		]);
		expect(html).toContain("apm");
		expect(html).toContain("Working…");
		expect(html).toContain("Found 6 pages missing meta");
		expect(html).toContain("Needs you");
		expect(html.match(/captains-group-label/g)).toHaveLength(1);
		expect(html).toContain(">content<");
		expect(html).toContain("2h");
		expect(html).toContain('data-status="working"');
		expect(html).toContain('data-status="needs"');
		expect(html).not.toContain("Give your Super agent a team");
		expect(html).toContain('aria-label="Edit seo"');
	});

	it("marks the open captain's row as the current page", () => {
		const html = render([captain({ chatId: "chat-1" })], {
			selectedChatId: "chat-1",
		});
		expect(html).toMatch(/aria-current="page"/);
	});

	it("does not show the empty state while the list is still loading", () => {
		expect(render(undefined)).not.toContain("Give your Super agent a team");
	});

	it("a captain with no answer yet says so", () => {
		expect(render([captain({})])).toContain("No messages yet");
	});
});
