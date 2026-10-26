import { afterEach, beforeEach, expect, it } from "vitest";
import { closeOnPageHide } from "./page-lifecycle";

beforeEach(() => {
	Object.assign(globalThis, { window: new EventTarget() });
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, "window");
});

it("closes a connection once, on pagehide or on cleanup", () => {
	let closes = 0;
	const cleanup = closeOnPageHide(() => closes++);
	window.dispatchEvent(new Event("pagehide"));
	window.dispatchEvent(new Event("pagehide"));
	cleanup();
	expect(closes).toBe(1);

	const other = closeOnPageHide(() => closes++);
	other();
	window.dispatchEvent(new Event("pagehide"));
	expect(closes).toBe(2);
});
