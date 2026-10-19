import { describe, expect, it } from "vitest";
import { jsonbText, withoutNul } from "./jsonb";

describe("jsonbText", () => {
	it("replaces NUL bytes in nested strings so Postgres jsonb accepts them", () => {
		const items = [
			{
				kind: "dynamicToolCall",
				tool: "bash",
				output: "#!/bin/sh\u0000\u0000ELF\u0001 tail",
				nested: { lines: ["a\u0000b"] },
			},
		];
		const text = jsonbText(items);
		expect(text).not.toContain("\\u0000");
		expect(JSON.parse(text)).toEqual([
			{
				kind: "dynamicToolCall",
				tool: "bash",
				output: "#!/bin/sh��ELF\u0001 tail",
				nested: { lines: ["a�b"] },
			},
		]);
	});

	it("leaves NUL-free values exactly as JSON.stringify writes them", () => {
		const value = {
			a: "plain \\u0000 text stays literal",
			b: [1, null, true],
			c: { d: "x" },
			e: undefined,
		};
		expect(jsonbText(value)).toBe(JSON.stringify(value));
	});

	it("cleans object keys too", () => {
		expect(JSON.parse(jsonbText({ "k\u0000": 1 }))).toEqual({ "k�": 1 });
	});

	it("keeps toJSON values (dates) working", () => {
		const date = new Date("2026-10-18T00:00:00.000Z");
		expect(jsonbText({ date })).toBe(JSON.stringify({ date }));
	});
});

describe("withoutNul", () => {
	it("returns the same text when there is no NUL", () => {
		expect(withoutNul("abc")).toBe("abc");
		expect(withoutNul("a\u0000")).toBe("a�");
	});
});
