import { expect, it } from "vitest";
import { enterSubmits } from "./task-input";

it("sends on Enter and keeps Shift+Enter and IME confirms in the draft", () => {
	const enter = { key: "Enter", shiftKey: false, keyCode: 13 };
	expect(enterSubmits({ ...enter, nativeEvent: { isComposing: false } })).toBe(
		true,
	);
	expect(enterSubmits({ ...enter, shiftKey: true })).toBe(false);
	expect(enterSubmits({ ...enter, nativeEvent: { isComposing: true } })).toBe(
		false,
	);
	expect(enterSubmits({ ...enter, keyCode: 229 })).toBe(false);
	expect(enterSubmits({ key: "a", shiftKey: false })).toBe(false);
});
