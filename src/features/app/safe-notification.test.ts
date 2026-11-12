import { afterEach, describe, expect, it, vi } from "vitest";
import {
	requestNotificationPermission,
	showNotification,
} from "./safe-notification";

afterEach(() => vi.unstubAllGlobals());

describe("showNotification", () => {
	it("does not throw when the browser refuses the constructor (Chrome on Android)", () => {
		function Refusing() {
			throw new TypeError("Illegal constructor");
		}
		Refusing.permission = "granted";
		vi.stubGlobal("Notification", Refusing);
		expect(() => showNotification("Chat", {}, () => {})).not.toThrow();
	});

	it("does nothing without permission or support", () => {
		const ctor = vi.fn();
		Object.assign(ctor, { permission: "default" });
		vi.stubGlobal("Notification", ctor);
		showNotification("Chat", {}, () => {});
		expect(ctor).not.toHaveBeenCalled();
		vi.stubGlobal("Notification", undefined);
		expect(() => showNotification("Chat", {}, () => {})).not.toThrow();
	});

	it("opens the chat from the click", () => {
		const created: { onclick?: () => void; close: () => void }[] = [];
		class Fake {
			static permission = "granted";
			close = vi.fn();
			onclick?: () => void;
			constructor() {
				created.push(this);
			}
		}
		vi.stubGlobal("Notification", Fake);
		vi.stubGlobal("window", { focus: vi.fn() });
		const open = vi.fn();
		showNotification("Chat", {}, open);
		created[0].onclick?.();
		expect(open).toHaveBeenCalledOnce();
		expect(created[0].close).toHaveBeenCalled();
	});
});

describe("requestNotificationPermission", () => {
	it("never throws, even when the request throws synchronously", () => {
		vi.stubGlobal("Notification", {
			permission: "default",
			requestPermission: () => {
				throw new Error("needs a gesture");
			},
		});
		expect(() => requestNotificationPermission()).not.toThrow();
	});
});
