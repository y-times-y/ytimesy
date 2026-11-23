import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sessionTitleFromText } from "../../domain/session-item";
import {
	type CrewNote,
	crewDigest,
	crewNoteFromItems,
} from "../../domain/y-squared-crew";
import { SqliteYSquaredCrew } from "./y-squared-crew-store";

function store() {
	const db = new DatabaseSync(":memory:");
	return new SqliteYSquaredCrew({
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	} as never);
}

const T0 = 1_000_000_000_000;
const LONG =
	"Make the sign-up form accept plus-addressed e-mails and show why it refused one\nDetails: ...";
const msg = (text: string, wake = false) =>
	({ kind: "userMessage", id: text.slice(0, 8), text, wake }) as never;

describe("every new thread has a title for Y²", () => {
	it("a start note names the thread as the sidebar does (it carried no title)", () => {
		const started = crewNoteFromItems([msg(LONG)], "running");
		expect(started.state).toBe("working");
		expect(started.title).toBe(sessionTitleFromText(LONG));
		expect(started.title).not.toBe("");
		// The settle note uses the same rule, so the row never changes name.
		expect(
			crewNoteFromItems(
				[msg(LONG), { kind: "agentMessage", id: "a", text: "Done" } as never],
				"completed",
			).title,
		).toBe(started.title);
	});

	it("falls back to the chat's own title, then to the request; never a wake or the placeholder", () => {
		expect(crewNoteFromItems([], "running", "Fix login").title).toBe(
			"Fix login",
		);
		expect(crewNoteFromItems([], "running", "New session").title).toBe("");
		expect(crewNoteFromItems([msg("PR merged", true)], "failed").title).toBe(
			"",
		);
	});

	it("a row whose notes carried no title takes one from its request", () => {
		const crew = store();
		const note: CrewNote = {
			sessionId: "t1",
			title: "",
			state: "working",
			waitingOn: null,
			prUrl: null,
			lastReply: null,
			lastRequest: "Add a health endpoint",
			userId: "u",
			projectId: "p",
			ySquaredId: "y2",
		};
		crew.noteThread(note, T0);
		expect(crew.thread("t1")?.title).toBe("Add a health endpoint");
		// A row already stored untitled (before this fix) still reads named.
		const old = { ...(crew.thread("t1") as never as object), title: "" };
		expect(crewDigest(old as never, T0).title).toBe("Add a health endpoint");
		expect(
			crewDigest(
				{ ...(old as never as object), lastRequest: null } as never,
				T0,
			).title,
		).toBe("Untitled");
	});
});
