import { describe, expect, it } from "vitest";
import {
	backspaceAt,
	deleteAt,
	otpBoxFor,
	otpDigits,
	pasteInto,
	typeInto,
} from "./otp-input";

describe("typing a code one digit per box", () => {
	it("fills the boxes from the left and moves the caret on", () => {
		let edit = typeInto("", 0, "4");
		expect(edit).toEqual({ value: "4", focus: 1 });
		edit = typeInto(edit.value, 1, "8");
		edit = typeInto(edit.value, 2, "2");
		expect(edit).toEqual({ value: "482", focus: 3 });
	});

	it("ignores anything that is not a digit", () => {
		expect(typeInto("48", 2, "x")).toEqual({ value: "48", focus: 2 });
		expect(typeInto("48", 2, " ")).toEqual({ value: "48", focus: 2 });
		expect(typeInto("", 0, "٣")).toEqual({ value: "", focus: 0 });
	});

	it("stops at the last box and keeps the caret there", () => {
		expect(typeInto("48291", 5, "3")).toEqual({ value: "482913", focus: 5 });
		expect(typeInto("482913", 5, "7")).toEqual({ value: "482917", focus: 5 });
	});

	it("never leaves a gap: a box past the end writes at the end", () => {
		expect(typeInto("48", 4, "9")).toEqual({ value: "489", focus: 3 });
		expect(otpBoxFor("48", 4)).toBe(2);
		expect(otpBoxFor("48", 1)).toBe(1);
		expect(otpBoxFor("482913", 5)).toBe(5);
	});

	it("typing over a digit in the middle goes on to the next box", () => {
		expect(typeInto("497", 1, "9")).toEqual({ value: "497", focus: 2 });
		expect(typeInto("4", 0, "8")).toEqual({ value: "8", focus: 1 });
	});

	it("replaces a digit typed over a digit, keeping the new one", () => {
		expect(typeInto("482913", 2, "27")).toEqual({ value: "487913", focus: 3 });
		expect(typeInto("482913", 2, "72")).toEqual({ value: "487913", focus: 3 });
	});
});

describe("pasting or auto-filling a code", () => {
	it("a whole code replaces everything, wherever it lands", () => {
		expect(pasteInto("", 0, "482913")).toEqual({ value: "482913", focus: 5 });
		expect(pasteInto("12", 4, "482913")).toEqual({
			value: "482913",
			focus: 5,
		});
		// The phone's suggestion arrives in the box that has focus.
		expect(typeInto("", 0, "482913")).toEqual({ value: "482913", focus: 5 });
	});

	it("keeps only the digits of what was copied", () => {
		expect(pasteInto("", 0, " 482-913 ")).toEqual({
			value: "482913",
			focus: 5,
		});
		expect(otpDigits("Your code is 482 913.")).toBe("482913");
		expect(otpDigits("1234567890")).toBe("123456");
	});

	it("a part is added where the caret is", () => {
		expect(pasteInto("48", 2, "29")).toEqual({ value: "4829", focus: 4 });
		expect(pasteInto("4829", 1, "77")).toEqual({ value: "477", focus: 3 });
	});

	it("pasting no digits changes nothing", () => {
		expect(pasteInto("48", 2, "abc")).toEqual({ value: "48", focus: 2 });
	});
});

describe("deleting", () => {
	it("backspace clears the digit in the box and closes the gap", () => {
		expect(backspaceAt("482913", 2)).toEqual({ value: "48913", focus: 2 });
	});

	it("backspace in an empty box clears the one before it and goes back", () => {
		expect(backspaceAt("482", 3)).toEqual({ value: "48", focus: 2 });
		expect(backspaceAt("4", 1)).toEqual({ value: "", focus: 0 });
	});

	it("backspace with nothing typed stays on the first box", () => {
		expect(backspaceAt("", 0)).toEqual({ value: "", focus: 0 });
		expect(backspaceAt("", 3)).toEqual({ value: "", focus: 0 });
	});

	it("delete clears the digit and keeps the caret in its box", () => {
		expect(deleteAt("482913", 1)).toEqual({ value: "42913", focus: 1 });
		expect(deleteAt("48", 5)).toEqual({ value: "48", focus: 5 });
	});
});
