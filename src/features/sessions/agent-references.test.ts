import { describe, expect, it } from "vitest";
import {
	EVENT_LINE_MAX_LENGTH,
	eventMarker,
	fitsEventLine,
	issueReference,
	pullRequestReference,
	pullRequestSegments,
	referenceKey,
	referenceSegments,
	statusMarker,
	threadReference,
	withEventLinesAsParagraphs,
} from "./agent-references";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("threadReference", () => {
	it("reads thread: and /thread/ links with a chat id", () => {
		expect(threadReference(`thread:${ID}`)).toBe(ID);
		expect(threadReference(`/thread/${ID.toUpperCase()}`)).toBe(ID);
	});
	it("rejects anything else", () => {
		for (const href of [
			"thread:abc",
			`thread:${ID}/x`,
			`https://example.com/thread/${ID}`,
			undefined,
		])
			expect(threadReference(href)).toBeNull();
	});
});

describe("pullRequestReference", () => {
	it("reads GitHub pull request URLs and pr: shorthands", () => {
		const expected = {
			owner: "acme",
			repo: "web",
			number: 8357,
			url: "https://github.com/acme/web/pull/8357",
		};
		expect(
			pullRequestReference("https://github.com/acme/web/pull/8357"),
		).toEqual(expected);
		expect(
			pullRequestReference("https://github.com/acme/web/pull/8357/files#diff"),
		).toEqual(expected);
		expect(pullRequestReference("pr:acme/web#8357")).toEqual(expected);
	});
	it("rejects issues, other hosts and malformed shorthands", () => {
		for (const href of [
			"https://github.com/acme/web/issues/1",
			"https://gitlab.com/acme/web/pull/1",
			"pr:acme#1",
			"pr:acme/web#x",
		])
			expect(pullRequestReference(href)).toBeNull();
	});
	it("splits prose around pr: shorthands", () => {
		expect(
			pullRequestSegments("Merge pr:acme/web#8 and pr:o/r#9.").map((segment) =>
				segment.kind === "text" ? segment.text : segment.pullRequest.number,
			),
		).toEqual(["Merge ", 8, " and ", 9, "."]);
		expect(pullRequestSegments("expr:a/b#1")).toEqual([
			{ kind: "text", text: "expr:a/b#1" },
		]);
	});
});

describe("event lines", () => {
	it("reads the short and the directive form", () => {
		expect(eventMarker("::finished All 3 threads finished")).toEqual({
			kind: "finished",
			length: 11,
		});
		expect(eventMarker('::event{kind="needs-you"}Merge it')?.kind).toBe(
			"needs-you",
		);
		expect(eventMarker("::merged")?.kind).toBe("merged");
		expect(eventMarker("::finishedly")).toBeNull();
		expect(eventMarker("::done ok")).toBeNull();
		expect(eventMarker("text ::failed")).toBeNull();
	});
	it("puts each event line in a paragraph of its own, outside code", () => {
		expect(
			withEventLinesAsParagraphs(
				"Started three.\n::finished All 3 finished\nNext step.",
			),
		).toBe("Started three.\n\n::finished All 3 finished\n\nNext step.");
		const fenced = "```\n::failed not an event\n```";
		expect(withEventLinesAsParagraphs(fenced)).toBe(fenced);
		const spaced = "A\n\n::merged B\n\nC";
		expect(withEventLinesAsParagraphs(spaced)).toBe(spaced);
		expect(
			withEventLinesAsParagraphs(":needs-you: A waits.\n:failed: B broke."),
		).toBe(":needs-you: A waits.\n\n:failed: B broke.");
	});
	it("reads status markers at the start of a paragraph only", () => {
		expect(statusMarker(":needs-you: Fix it")).toEqual({
			kind: "needs-you",
			length: 12,
		});
		expect(statusMarker(":failed:B")?.kind).toBe("failed");
		expect(statusMarker("::failed B")).toBeNull();
		expect(statusMarker(":done: B")).toBeNull();
		expect(statusMarker("x :merged: B")).toBeNull();
		expect(eventMarker(":finished: B")).toBeNull();
	});
	it("keeps only short events on one centered line", () => {
		expect(fitsEventLine("All 3 threads finished")).toBe(true);
		expect(fitsEventLine("x".repeat(EVENT_LINE_MAX_LENGTH))).toBe(true);
		expect(fitsEventLine("x".repeat(EVENT_LINE_MAX_LENGTH + 1))).toBe(false);
	});
});

describe("issueReference", () => {
	it("reads issue URLs and issue: shorthand", () => {
		expect(issueReference("https://github.com/acme/web/issues/12#c")).toEqual({
			owner: "acme",
			repo: "web",
			number: 12,
			url: "https://github.com/acme/web/issues/12",
		});
		expect(issueReference("issue:acme/web#7")?.number).toBe(7);
		expect(issueReference("https://github.com/acme/web/pull/7")).toBeNull();
		expect(issueReference("https://evil.com/acme/web/issues/7")).toBeNull();
	});
});

describe("referenceSegments", () => {
	const options: Parameters<typeof referenceSegments>[1] = {
		defaultRepository: "acme/web",
		threads: new Map([["WEB-3F9A", { id: ID, title: "Fix" }]]),
	};
	const kinds = (text: string, o = options) =>
		referenceSegments(text, o).map((s) =>
			s.kind === "text"
				? s.text
				: s.kind === "issue"
					? `issue:${referenceKey(s.issue)}`
					: s.kind === "pullRequest"
						? `pr:${referenceKey(s.pullRequest)}`
						: `thread:${s.label}`,
		);

	it("links bare numbers, qualified numbers, pr: and thread labels", () => {
		expect(
			kinds("Fixed #12, see org/repo#3 and pr:acme/web#8 via WEB-3F9A."),
		).toEqual([
			"Fixed ",
			"issue:acme/web#12",
			", see ",
			"issue:org/repo#3",
			" and ",
			"pr:acme/web#8",
			" via ",
			"thread:WEB-3F9A",
			".",
		]);
	});
	it("leaves a bare number alone without a repository, and anchors, colours and words", () => {
		expect(
			kinds("#12", { defaultRepository: undefined, threads: new Map() }),
		).toEqual(["#12"]);
		expect(kinds("a&#12; x#12 ##12 v1.#12 abc#12")).toEqual([
			"a&#12; x#12 ##12 v1.#12 abc#12",
		]);
	});
});
