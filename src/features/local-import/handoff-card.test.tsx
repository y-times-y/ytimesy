import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { HandoffSessionItem } from "#/domain/session-item";
import { HandoffCard } from "./handoff-card";

const base: HandoffSessionItem = {
	kind: "handoff",
	id: SessionItemId("handoff-1"),
	tool: "claude",
	title: "Fix the login redirect",
	turns: 221,
	at: "2026-11-01T10:00:00Z",
	context: "MODEL-ONLY CONTEXT",
};

describe("HandoffCard", () => {
	it("shows the agent, at most three short lines and turns · date · branch", () => {
		const html = renderToStaticMarkup(
			<HandoffCard
				item={{
					...base,
					branch: "ytimesy/fix-login-ab12",
					summary: {
						goal: "The login page loops after OAuth.",
						stopped: "Done — the redirect checks the session first.",
						next: "Ship the cookie change",
						localBranch: "fix-login",
						edited: ["src/auth.ts"],
						editedCount: 1,
						commands: ["pnpm test"],
						transcript: "~/.ytimesy/handoff/claude-s1/transcript.md",
					},
					files: {
						pushed: ["src/auth.ts", "notes.md"],
						pushedCount: 2,
						skipped: [".env"],
						skippedCount: 1,
					},
				}}
			/>,
		);
		expect(html).toContain("Continued from Claude Code");
		expect(html).toContain("<dt>Goal</dt>");
		expect(html).toContain("The login page loops after OAuth.");
		expect(html).toContain("<dt>Stopped</dt>");
		expect(html).toContain("<dt>Next</dt>");
		expect(html).toContain("221 turns · Nov 1 · fix-login");
		// Details are folded: a closed <details>, so first paint is the same everywhere.
		expect(html).toMatch(/<details class="handoff-card-details">/);
		expect(html).not.toContain("<details open");
		expect(html).toContain("Edited (1)");
		expect(html).toContain("Commands that worked (1)");
		expect(html).toContain("Pushed (2)");
		expect(html).toContain("notes.md");
		expect(html).toContain("Skipped (1)");
		expect(html).toContain("ytimesy/fix-login-ab12");
		expect(html).toContain("~/.ytimesy/handoff/claude-s1/transcript.md");
		expect(html).not.toContain("MODEL-ONLY CONTEXT");
	});

	it("leaves out lines it could not derive and caps long lists", () => {
		const pushed = Array.from({ length: 200 }, (_, index) => `f${index}.ts`);
		const html = renderToStaticMarkup(
			<HandoffCard
				item={{
					...base,
					summary: {
						goal: "Fix it",
						stopped: null,
						next: null,
						localBranch: null,
						edited: [],
						editedCount: 0,
						commands: [],
						transcript: "~/.ytimesy/handoff/claude-s1/transcript.md",
					},
					files: {
						pushed,
						pushedCount: 450,
						skipped: [],
						skippedCount: 0,
					},
				}}
			/>,
		);
		expect(html).toContain("<dt>Goal</dt>");
		expect(html).not.toContain("<dt>Stopped</dt>");
		expect(html).not.toContain("<dt>Next</dt>");
		expect(html).toContain("221 turns · Nov 1</span>");
		expect(html).toContain("Pushed (450)");
		expect(html).toContain("+420 more");
		expect(html).not.toContain("Skipped (");
	});

	it("keeps the one line for chats imported before the summary", () => {
		const html = renderToStaticMarkup(<HandoffCard item={base} />);
		expect(html).toContain("Continued from Claude Code · 221 turns · Nov 1");
		expect(html).not.toContain("<details");
	});
});
