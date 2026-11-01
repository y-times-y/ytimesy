import { describe, expect, it } from "vitest";
import {
	handoffSummary,
	plainSummaryText,
	SUMMARY_FILES,
	shortened,
} from "./handoff-summary";
import type { HandoffDocument } from "./local-import";

type Turn = HandoffDocument["turns"][number];
const user = (text: string, extra: Partial<Turn> = {}): Turn => ({
	role: "user",
	text,
	toolCalls: [],
	...extra,
});
const agent = (text: string): Turn => ({
	role: "assistant",
	text,
	toolCalls: [],
});

function handoff(overrides: Partial<HandoffDocument> = {}): HandoffDocument {
	return {
		version: 1,
		tool: "claude",
		sessionId: "s1",
		title: "Fix the login redirect",
		cwd: "/Users/alice/app",
		gitBranch: "fix-login",
		updatedAt: "2026-11-01T10:00:00Z",
		totalTurns: 221,
		turns: [],
		successfulCommands: [],
		files: { edited: [], written: [], read: [] },
		...overrides,
	};
}

const transcript = "~/.ytimesy/handoff/claude-s1/transcript.md";

describe("handoff summary", () => {
	it("takes the first request, the gist of the last reply and its next step", () => {
		const summary = handoffSummary(
			handoff({
				turns: [
					user(
						"<command-name>/clear</command-name>\nThe login page loops after OAuth. Please fix it and add a test.",
					),
					agent("Looking at the redirect handler."),
					user("Also keep the session cookie."),
					agent(
						"Done — the redirect now checks the session first. Tests pass.\n\n## Next steps\n- Ship the cookie change behind a flag\n- Update the docs",
					),
				],
			}),
			{ transcript },
		);
		expect(summary.goal).toBe("The login page loops after OAuth.");
		expect(summary.stopped).toBe(
			"Done — the redirect now checks the session first.",
		);
		expect(summary.next).toBe("Ship the cookie change behind a flag");
		expect(summary.localBranch).toBe("fix-login");
		expect(summary.transcript).toBe(transcript);
	});

	it("uses an unanswered last request as next, and the title once early turns were trimmed", () => {
		const summary = handoffSummary(
			handoff({
				turns: [
					user("Earlier turns, digested.", { synthetic: "trim-digest" }),
					user("Rename the helper."),
					agent("Renamed it in src/a.ts."),
					user("[Request interrupted by user]"),
					user("Now run the e2e suite"),
				],
			}),
			{ transcript },
		);
		expect(summary.goal).toBe("Fix the login redirect");
		expect(summary.stopped).toBe("Renamed it in src/a.ts.");
		expect(summary.next).toBe("Now run the e2e suite");
	});

	it("has no next when nothing is derivable, and nulls for an empty session", () => {
		const plain = handoffSummary(
			handoff({ turns: [user("Fix it"), agent("Fixed.")] }),
			{ transcript },
		);
		expect(plain.next).toBeNull();
		const empty = handoffSummary(handoff({ title: undefined }), {
			transcript,
		});
		expect(empty).toMatchObject({ goal: null, stopped: null, next: null });
	});

	it("keeps lines short and lists files relative to the folder, bounded", () => {
		const long = `${"word ".repeat(80)}end.`;
		const files = Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`);
		const summary = handoffSummary(
			handoff({
				turns: [user(long), agent(long)],
				successfulCommands: ["pnpm test", "pnpm test", "pnpm  lint"],
				files: {
					edited: ["/Users/alice/app/src/a.ts", ...files],
					written: ["src/a.ts", "README.md"],
					read: ["ignored.ts"],
				},
			}),
			{ transcript },
		);
		expect(summary.goal?.length).toBeLessThanOrEqual(110);
		expect(summary.goal?.endsWith("…")).toBe(true);
		expect(summary.stopped?.length).toBeLessThanOrEqual(130);
		expect(summary.edited).toHaveLength(SUMMARY_FILES);
		expect(summary.edited[0]).toBe("src/a.ts");
		expect(summary.editedCount).toBe(32);
		expect(summary.commands).toEqual(["pnpm test", "pnpm lint"]);
	});

	it("drops markup, code and links from the text", () => {
		expect(
			plainSummaryText(
				"**Fixed** the [parser](https://x.test) in `a.ts`:\n```ts\ncode()\n```\n<system-reminder>hidden</system-reminder> done",
			),
		).toBe("Fixed the parser in a.ts: done");
		expect(shortened("one two three four", 10)).toBe("one two…");
	});
});
