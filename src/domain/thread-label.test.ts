import { describe, expect, it } from "vitest";
import {
	legacyThreadLabel,
	threadDirectory,
	threadLabel,
	threadLabelPrefix,
	threadLabelSegments,
	threadSlug,
} from "./thread-label";

const A = "3f9a1c2e-0000-4000-8000-000000000001";
const B = "00c4d5e6-0000-4000-8000-000000000002";

describe("thread names", () => {
	it("makes the project part from the project's name", () => {
		expect(threadSlug("ytimesy")).toBe("ytimesy");
		expect(threadSlug("Web app")).toBe("web-app");
		expect(threadSlug("acme/Web.v2")).toBe("acme-web-v2");
		expect(threadSlug("  ")).toBe("thread");
		expect(threadSlug("日本語")).toBe("thread");
		expect(threadSlug(null)).toBe("thread");
	});

	it("cuts a long project name at a word, or inside one word", () => {
		expect(threadSlug("my very long marketing website")).toBe("my-very-long");
		expect(threadSlug("a".repeat(40))).toHaveLength(20);
	});

	it("names a numbered thread with its project and number", () => {
		expect(threadLabel("ytimesy", { id: A, threadNumber: 12 })).toBe(
			"ytimesy-12",
		);
		expect(threadLabel("Web app", { id: A, threadNumber: 1 })).toBe(
			"web-app-1",
		);
	});

	it("keeps the old label for a thread without a number", () => {
		expect(threadLabel("Web app", { id: A })).toBe("WEB-3F9A");
		expect(threadLabel("Web app", { id: A, threadNumber: null })).toBe(
			"WEB-3F9A",
		);
		expect(threadLabel("Web app", { id: "xyz" })).toBeNull();
		expect(threadLabelPrefix("acme/web")).toBe("ACM");
		expect(legacyThreadLabel("WEB", A)).toBe("WEB-3F9A");
	});
});

describe("thread names in text", () => {
	const directory = threadDirectory("ytimesy", [
		{ id: A, title: "Fix form", threadNumber: 12 },
		{ id: B, title: "Test", threadNumber: 1 },
	]);

	it("links numbered names and the old labels, and leaves unknown ones", () => {
		expect(
			threadLabelSegments(
				"ytimesy-12 fixes it, ytimesy-99 is not a thread, see YTI-00C4.",
				directory,
			),
		).toEqual([
			{ kind: "thread", label: "ytimesy-12", id: A },
			{ kind: "text", text: " fixes it, ytimesy-99 is not a thread, see " },
			{ kind: "thread", label: "YTI-00C4", id: B },
			{ kind: "text", text: "." },
		]);
	});

	it("does not match inside a longer word or number", () => {
		expect(
			threadLabelSegments("xytimesy-12 and ytimesy-123", directory),
		).toEqual([{ kind: "text", text: "xytimesy-12 and ytimesy-123" }]);
	});

	it("prefers the longer name: ytimesy-12 is not ytimesy-1", () => {
		const segments = threadLabelSegments(
			"ytimesy-12 then ytimesy-1",
			directory,
		);
		expect(segments.filter((s) => s.kind === "thread")).toEqual([
			{ kind: "thread", label: "ytimesy-12", id: A },
			{ kind: "thread", label: "ytimesy-1", id: B },
		]);
	});

	it("reads a name in any case", () => {
		expect(threadLabelSegments("see YTIMESY-12", directory)[1]).toEqual({
			kind: "thread",
			label: "YTIMESY-12",
			id: A,
		});
	});

	it("lets a numbered name win over another thread's old label that reads the same", () => {
		const clash = threadDirectory("web", [
			{ id: "12345678-0000-4000-8000-000000000003", title: "Old" },
			{ id: A, title: "New", threadNumber: 1234 },
		]);
		expect(clash.get("web-1234")?.title).toBe("New");
	});

	it("returns the text untouched when there is nothing to link", () => {
		expect(threadLabelSegments("hello", new Map())).toEqual([
			{ kind: "text", text: "hello" },
		]);
		expect(threadLabelSegments("", new Map())).toEqual([]);
	});
});
