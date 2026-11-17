import { describe, expect, it } from "vitest";
import {
	threadDirectory,
	threadLabel,
	threadLabelPrefix,
	threadLabelSegments,
} from "./thread-label";

const A = "3f9a1c2e-0000-4000-8000-000000000001";
const B = "00c4d5e6-0000-4000-8000-000000000002";

describe("thread labels", () => {
	it("derives a prefix from the project name", () => {
		expect(threadLabelPrefix("Web app")).toBe("WEB");
		expect(threadLabelPrefix("acme/web")).toBe("ACM");
		expect(threadLabelPrefix("  ")).toBe("THR");
		expect(threadLabelPrefix("日本語")).toBe("THR");
		expect(threadLabelPrefix(null)).toBe("THR");
	});

	it("is stable and built from the chat id", () => {
		expect(threadLabel("WEB", A)).toBe("WEB-3F9A");
		expect(threadLabel("WEB", "xyz")).toBeNull();
	});

	it("links known labels in prose and leaves unknown ones", () => {
		const directory = threadDirectory("WEB", [
			{ id: A, title: "Fix form" },
			{ id: B, title: "Test" },
		]);
		expect(
			threadLabelSegments(
				"WEB-3F9A fixes, WEB-FFFF not, see WEB-00C4.",
				directory,
			),
		).toEqual([
			{ kind: "thread", label: "WEB-3F9A", id: A },
			{ kind: "text", text: " fixes, WEB-FFFF not, see " },
			{ kind: "thread", label: "WEB-00C4", id: B },
			{ kind: "text", text: "." },
		]);
		expect(threadLabelSegments("XWEB-3F9A1", directory)).toEqual([
			{ kind: "text", text: "XWEB-3F9A1" },
		]);
	});
});
