import { describe, expect, it } from "vitest";
import {
	adjacentChatId,
	chordText,
	type KeyFocus,
	matchShortcut,
	SHORTCUTS,
	type ShortcutKeyEvent,
	type ShortcutPlatform,
	shortcutHint,
	shortcutMatches,
	shortcutPlatformFrom,
	titleWithShortcut,
} from "./keyboard-shortcuts";

function press(
	key: string,
	modifiers: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
	return {
		key,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...modifiers,
	};
}

function matched(
	event: ShortcutKeyEvent,
	platform: ShortcutPlatform,
	focus: KeyFocus = "page",
) {
	return matchShortcut(event, focus, platform)?.shortcut.id ?? null;
}

describe("matching keys", () => {
	it("reads Mod as Cmd on a Mac and Ctrl elsewhere", () => {
		expect(matched(press("k", { metaKey: true }), "mac")).toBe(
			"commandPalette",
		);
		expect(matched(press("k", { ctrlKey: true }), "mac")).toBeNull();
		expect(matched(press("k", { ctrlKey: true }), "other")).toBe(
			"commandPalette",
		);
		expect(matched(press("k", { metaKey: true }), "other")).toBeNull();
	});

	it("needs exactly the chord's modifiers", () => {
		expect(matched(press("b", { metaKey: true }), "mac")).toBe("toggleSidebar");
		expect(
			matched(press("b", { metaKey: true, shiftKey: true }), "mac"),
		).toBeNull();
		expect(matched(press("o", { metaKey: true }), "mac")).toBeNull();
		expect(matched(press("O", { metaKey: true, shiftKey: true }), "mac")).toBe(
			"newChat",
		);
	});

	it("finds the key Option changed by its physical position", () => {
		expect(
			matched(press("∫", { code: "KeyB", metaKey: true, altKey: true }), "mac"),
		).toBe("toggleInspector");
	});

	it("never turns a letter on another layout into a shortcut", () => {
		// Dvorak: Cmd+X is typed on the key where QWERTY has B.
		expect(matched(press("x", { code: "KeyB", metaKey: true }), "mac")).toBe(
			null,
		);
	});

	it("binds Ctrl+` for the terminal on every platform", () => {
		expect(matched(press("`", { ctrlKey: true }), "mac")).toBe(
			"toggleTerminal",
		);
		expect(matched(press("`", { ctrlKey: true }), "other")).toBe(
			"toggleTerminal",
		);
		expect(matched(press("`", { metaKey: true }), "mac")).toBeNull();
	});

	it("tells the chat number from the chord", () => {
		const match = matchShortcut(press("3", { ctrlKey: true }), "page", "other");
		expect(match?.shortcut.id).toBe("jumpToChat");
		expect(match?.chordIndex).toBe(2);
	});

	it("leaves keys an input method is composing alone", () => {
		expect(
			matched(press("k", { metaKey: true, isComposing: true }), "mac"),
		).toBeNull();
		expect(matched(press("k", { metaKey: true, keyCode: 229 }), "mac")).toBe(
			null,
		);
	});
});

describe("typing in a field", () => {
	it("keeps a bare ? for the text, but opens the sheet from the page", () => {
		const question = press("?", { shiftKey: true });
		expect(matched(question, "other")).toBe("shortcuts");
		expect(matched(question, "other", "emptyField")).toBeNull();
		expect(matched(question, "other", "filledField")).toBeNull();
		expect(matched(press("/", { metaKey: true }), "mac", "filledField")).toBe(
			"shortcuts",
		);
	});

	it("steps through chats from an empty field only", () => {
		const up = press("ArrowUp", { altKey: true });
		expect(matched(up, "mac", "page")).toBe("previousChat");
		expect(matched(up, "mac", "emptyField")).toBe("previousChat");
		expect(matched(up, "mac", "filledField")).toBeNull();
	});

	it("lets Mod shortcuts through while typing", () => {
		expect(
			matched(
				press("o", { ctrlKey: true, shiftKey: true }),
				"other",
				"filledField",
			),
		).toBe("newChat");
	});

	it("stops from the composer with Esc only while it is empty", () => {
		const esc = press("Escape");
		expect(shortcutMatches("stopFromComposer", esc, "emptyField", "mac")).toBe(
			true,
		);
		expect(shortcutMatches("stopFromComposer", esc, "filledField", "mac")).toBe(
			false,
		);
	});

	it("leaves Ctrl keys to the shell in the terminal, except Ctrl+`", () => {
		expect(matched(press("b", { ctrlKey: true }), "other", "terminal")).toBe(
			null,
		);
		expect(matched(press("b", { metaKey: true }), "mac", "terminal")).toBe(
			"toggleSidebar",
		);
		expect(matched(press("`", { ctrlKey: true }), "other", "terminal")).toBe(
			"toggleTerminal",
		);
	});
});

describe("showing keys", () => {
	it("uses Mac glyphs and the usual words elsewhere", () => {
		expect(shortcutHint("newChat", "mac")).toBe("⇧⌘O");
		expect(shortcutHint("newChat", "other")).toBe("Ctrl+Shift+O");
		expect(shortcutHint("toggleInspector", "mac")).toBe("⌥⌘B");
		expect(shortcutHint("toggleInspector", "other")).toBe("Ctrl+Alt+B");
		expect(shortcutHint("toggleTerminal", "mac")).toBe("⌃`");
		expect(shortcutHint("jumpToChat", "other")).toBe("Ctrl+1–9");
		expect(chordText({ key: "?", shift: true }, "mac")).toBe("?");
	});

	it("titles a button with its shortcut once one is known", () => {
		expect(titleWithShortcut("Settings", "⌘,")).toBe("Settings (⌘,)");
		expect(titleWithShortcut("Settings", "")).toBe("Settings");
	});

	it("detects the platform", () => {
		expect(shortcutPlatformFrom("MacIntel")).toBe("mac");
		expect(shortcutPlatformFrom("macOS")).toBe("mac");
		expect(shortcutPlatformFrom("Win32")).toBe("other");
		expect(shortcutPlatformFrom("Linux x86_64")).toBe("other");
	});

	it("never binds a combination twice", () => {
		const seen = new Set<string>();
		for (const shortcut of SHORTCUTS)
			for (const chord of shortcut.chords) {
				const text = chordText(chord, "mac");
				expect(seen.has(text), text).toBe(false);
				seen.add(text);
			}
	});

	it("never binds what the browser keeps (Cmd+W, T, N, L, Q)", () => {
		for (const shortcut of SHORTCUTS)
			for (const chord of shortcut.chords)
				if (chord.mod && !chord.shift && !chord.alt)
					expect(["w", "t", "n", "l", "q"]).not.toContain(chord.key);
	});
});

describe("stepping through the sidebar", () => {
	const ids = ["a", "b", "c"];
	it("moves one row and wraps", () => {
		expect(adjacentChatId(ids, "b", 1)).toBe("c");
		expect(adjacentChatId(ids, "c", 1)).toBe("a");
		expect(adjacentChatId(ids, "a", -1)).toBe("c");
	});
	it("starts at an end when no listed chat is open", () => {
		expect(adjacentChatId(ids, undefined, 1)).toBe("a");
		expect(adjacentChatId(ids, "gone", -1)).toBe("c");
		expect(adjacentChatId([], "a", 1)).toBeUndefined();
	});
});
