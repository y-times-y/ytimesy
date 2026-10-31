/**
 * Every keyboard shortcut in the app, in one list: the global listener, the
 * composer, the help sheet and the button tooltips all read it, so what is
 * bound and what is shown cannot drift apart.
 */

export type ShortcutPlatform = "mac" | "other";

/** One key combination. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is Ctrl everywhere. */
export type KeyChord = {
	/** `KeyboardEvent.key` as typed without Shift (letters lowercase), or a named key. */
	readonly key: string;
	readonly mod?: boolean;
	readonly ctrl?: boolean;
	readonly shift?: boolean;
	readonly alt?: boolean;
};

/**
 * Where focus may be for the shortcut to fire: "always" (it holds Mod or
 * Ctrl, which typing never does), "emptyField" (in a text field only while
 * it is empty, so Option+Up still moves the caret in text), "never".
 */
export type ShortcutFieldRule = "always" | "emptyField" | "never";

export type ShortcutGroup = "General" | "Chats" | "Panels" | "Composer";

export type ShortcutId =
	| "commandPalette"
	| "shortcuts"
	| "toggleSidebar"
	| "toggleInspector"
	| "openSettings"
	| "newChat"
	| "previousChat"
	| "nextChat"
	| "jumpToChat"
	| "copyLastReply"
	| "toggleTerminal"
	| "toggleDesktop"
	| "openPullRequest"
	| "modelPicker"
	| "focusComposer"
	| "stop"
	| "stopFromComposer"
	| "send"
	| "newline"
	| "saveFile";

export type ShortcutDefinition = {
	readonly id: ShortcutId;
	readonly label: string;
	readonly group: ShortcutGroup;
	readonly chords: readonly KeyChord[];
	readonly inTextFields: ShortcutFieldRule;
	/**
	 * "global": the page's listener binds it. "composer" and "editor": the
	 * message box or the file editor binds it itself; listed for the help sheet.
	 */
	readonly scope: "global" | "composer" | "editor";
	/** Still fires from the terminal and the shared desktop, which otherwise keep every key. */
	readonly inTerminal?: boolean;
	/** Shown in place of the first chord's key (Mod+1…9 lists as one row). */
	readonly displayKey?: string;
};

const CHAT_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export const SHORTCUTS: readonly ShortcutDefinition[] = [
	{
		id: "commandPalette",
		label: "Search chats and actions",
		group: "General",
		chords: [{ key: "k", mod: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "shortcuts",
		label: "Keyboard shortcuts",
		group: "General",
		chords: [
			{ key: "/", mod: true },
			{ key: "?", shift: true },
		],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "openSettings",
		label: "Open settings",
		group: "General",
		chords: [{ key: ",", mod: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "toggleSidebar",
		label: "Toggle left sidebar",
		group: "Panels",
		chords: [{ key: "b", mod: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "toggleInspector",
		label: "Toggle right panel",
		group: "Panels",
		chords: [{ key: "b", mod: true, alt: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "toggleTerminal",
		label: "Toggle terminal",
		group: "Panels",
		chords: [{ key: "`", ctrl: true }],
		inTextFields: "always",
		scope: "global",
		inTerminal: true,
	},
	{
		id: "toggleDesktop",
		label: "Toggle desktop",
		group: "Panels",
		chords: [{ key: "d", mod: true, shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "openPullRequest",
		label: "Open pull request",
		group: "Panels",
		chords: [{ key: "p", mod: true, shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "newChat",
		label: "New chat",
		group: "Chats",
		chords: [{ key: "o", mod: true, shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "previousChat",
		label: "Previous chat",
		group: "Chats",
		chords: [{ key: "ArrowUp", alt: true }],
		inTextFields: "emptyField",
		scope: "global",
	},
	{
		id: "nextChat",
		label: "Next chat",
		group: "Chats",
		chords: [{ key: "ArrowDown", alt: true }],
		inTextFields: "emptyField",
		scope: "global",
	},
	{
		id: "jumpToChat",
		label: "Go to chat 1–9 in the sidebar",
		group: "Chats",
		chords: CHAT_NUMBERS.map((key) => ({ key, mod: true })),
		inTextFields: "always",
		scope: "global",
		displayKey: "1–9",
	},
	{
		id: "copyLastReply",
		label: "Copy last reply",
		group: "Chats",
		chords: [{ key: "c", mod: true, shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "focusComposer",
		label: "Focus message box",
		group: "Composer",
		chords: [{ key: "Escape", shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "send",
		label: "Send",
		group: "Composer",
		chords: [{ key: "Enter" }, { key: "Enter", mod: true }],
		inTextFields: "always",
		scope: "composer",
	},
	{
		id: "newline",
		label: "New line",
		group: "Composer",
		chords: [{ key: "Enter", shift: true }],
		inTextFields: "always",
		scope: "composer",
	},
	{
		id: "modelPicker",
		label: "Choose model",
		group: "Composer",
		chords: [{ key: "m", mod: true, shift: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "stop",
		label: "Stop the running turn",
		group: "Composer",
		chords: [{ key: ".", mod: true }],
		inTextFields: "always",
		scope: "global",
	},
	{
		id: "stopFromComposer",
		label: "Stop the running turn (empty message box)",
		group: "Composer",
		chords: [{ key: "Escape" }],
		inTextFields: "emptyField",
		scope: "composer",
	},
	{
		id: "saveFile",
		label: "Save file (file editor)",
		group: "Panels",
		chords: [{ key: "s", mod: true }],
		inTextFields: "always",
		scope: "editor",
	},
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	"General",
	"Chats",
	"Panels",
	"Composer",
];

export function shortcutById(id: ShortcutId): ShortcutDefinition {
	const found = SHORTCUTS.find((shortcut) => shortcut.id === id);
	if (!found) throw new Error(`Unknown shortcut ${id}`);
	return found;
}

export function shortcutPlatformFrom(platform: string): ShortcutPlatform {
	return /mac|iphone|ipad|ipod/i.test(platform) ? "mac" : "other";
}

/** The physical key, for when a modifier changed the typed character (Option+B types ∫ on a Mac). */
const KEY_CODES: Readonly<Record<string, string>> = {
	"/": "Slash",
	"?": "Slash",
	",": "Comma",
	".": "Period",
	"`": "Backquote",
};

function physicalCode(key: string): string | undefined {
	if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	return KEY_CODES[key];
}

export type ShortcutKeyEvent = {
	readonly key: string;
	readonly code?: string;
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly isComposing?: boolean;
	readonly keyCode?: number;
};

/** A key that confirms an input method (IME) candidate belongs to the IME. */
export function keyEventIsComposing(event: ShortcutKeyEvent): boolean {
	// Safari reports the composition-ending key as keyCode 229 only.
	return Boolean(event.isComposing) || event.keyCode === 229;
}

function keyMatches(key: string, event: ShortcutKeyEvent): boolean {
	if (event.key.toLowerCase() === key.toLowerCase()) return true;
	// A plain letter or digit was typed: that is the key, whatever its
	// position (Dvorak's Cmd+X must stay Cut, not become the B shortcut).
	if (/^[a-z0-9]$/i.test(event.key)) return false;
	const code = physicalCode(key);
	return code !== undefined && event.code === code;
}

export function chordMatches(
	chord: KeyChord,
	event: ShortcutKeyEvent,
	platform: ShortcutPlatform,
): boolean {
	const mac = platform === "mac";
	const wantMeta = mac && Boolean(chord.mod);
	const wantCtrl = Boolean(chord.ctrl) || (!mac && Boolean(chord.mod));
	return (
		event.metaKey === wantMeta &&
		event.ctrlKey === wantCtrl &&
		event.altKey === Boolean(chord.alt) &&
		event.shiftKey === Boolean(chord.shift) &&
		keyMatches(chord.key, event)
	);
}

/** Where the key was pressed, as far as shortcuts care. */
export type KeyFocus =
	| "page"
	| "emptyField"
	| "filledField"
	/** The terminal or the shared desktop: they forward keys to the machine. */
	| "terminal";

export function shortcutAllowedAt(
	shortcut: ShortcutDefinition,
	focus: KeyFocus,
	chord: KeyChord,
	platform: ShortcutPlatform,
): boolean {
	if (focus === "page") return true;
	// A bare "?" types a "?" wherever text goes, whatever the shortcut's rule.
	const typesText = !chord.mod && !chord.ctrl && chord.key.length === 1;
	if (typesText) return false;
	if (focus === "terminal")
		// Cmd never reaches a shell; Ctrl on Linux and Windows does (Ctrl+B, Ctrl+K).
		return (
			Boolean(shortcut.inTerminal) ||
			(platform === "mac" && Boolean(chord.mod) && !chord.ctrl)
		);
	if (shortcut.inTextFields === "always") return true;
	return shortcut.inTextFields === "emptyField" && focus === "emptyField";
}

export type ShortcutMatch = {
	readonly shortcut: ShortcutDefinition;
	/** Which of its chords matched (Mod+3 is chord 2 of "jumpToChat"). */
	readonly chordIndex: number;
};

export function matchShortcut(
	event: ShortcutKeyEvent,
	focus: KeyFocus,
	platform: ShortcutPlatform,
	shortcuts: readonly ShortcutDefinition[] = SHORTCUTS,
): ShortcutMatch | null {
	if (keyEventIsComposing(event)) return null;
	for (const shortcut of shortcuts) {
		const chordIndex = shortcut.chords.findIndex((chord) =>
			chordMatches(chord, event, platform),
		);
		const chord = shortcut.chords[chordIndex];
		if (!chord) continue;
		if (!shortcutAllowedAt(shortcut, focus, chord, platform)) return null;
		return { shortcut, chordIndex };
	}
	return null;
}

export function shortcutMatches(
	id: ShortcutId,
	event: ShortcutKeyEvent,
	focus: KeyFocus,
	platform: ShortcutPlatform,
): boolean {
	return (
		matchShortcut(event, focus, platform, [shortcutById(id)])?.shortcut.id ===
		id
	);
}

const MAC_KEY_NAMES: Readonly<Record<string, string>> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	Escape: "Esc",
	Enter: "↩",
};

const OTHER_KEY_NAMES: Readonly<Record<string, string>> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	Escape: "Esc",
	Enter: "Enter",
};

/** The keys to press, in each platform's usual order: ⌃⌥⇧⌘ on a Mac, Ctrl+Alt+Shift elsewhere. */
export function chordKeys(
	chord: KeyChord,
	platform: ShortcutPlatform,
	displayKey?: string,
): string[] {
	const mac = platform === "mac";
	const key =
		displayKey ??
		(mac ? MAC_KEY_NAMES : OTHER_KEY_NAMES)[chord.key] ??
		chord.key.toUpperCase();
	// "?" already means Shift+/.
	const shift = chord.shift && chord.key !== "?";
	if (mac)
		return [
			...(chord.ctrl ? ["⌃"] : []),
			...(chord.alt ? ["⌥"] : []),
			...(shift ? ["⇧"] : []),
			...(chord.mod ? ["⌘"] : []),
			key,
		];
	return [
		...(chord.ctrl || chord.mod ? ["Ctrl"] : []),
		...(chord.alt ? ["Alt"] : []),
		...(shift ? ["Shift"] : []),
		key,
	];
}

export function chordText(
	chord: KeyChord,
	platform: ShortcutPlatform,
	displayKey?: string,
): string {
	return chordKeys(chord, platform, displayKey).join(
		platform === "mac" ? "" : "+",
	);
}

/** The first chord, as a tooltip shows it: "⌘B", "Ctrl+B". */
export function shortcutHint(
	id: ShortcutId,
	platform: ShortcutPlatform,
): string {
	const shortcut = shortcutById(id);
	const chord = shortcut.chords[0];
	return chord ? chordText(chord, platform, shortcut.displayKey) : "";
}

/** A button's title with its shortcut, as VS Code shows them: "Toggle (⌘B)". */
export function titleWithShortcut(label: string, hint: string): string {
	return hint ? `${label} (${hint})` : label;
}

/** The chat a step away in the sidebar's order; it wraps at either end. */
export function adjacentChatId(
	chatIds: readonly string[],
	currentId: string | undefined,
	step: 1 | -1,
): string | undefined {
	if (!chatIds.length) return undefined;
	const index = currentId ? chatIds.indexOf(currentId) : -1;
	if (index === -1) return step === 1 ? chatIds[0] : chatIds.at(-1);
	return chatIds[(index + step + chatIds.length) % chatIds.length];
}
