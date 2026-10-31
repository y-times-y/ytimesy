import { Dialog } from "radix-ui";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	chordKeys,
	type KeyFocus,
	matchShortcut,
	SHORTCUT_GROUPS,
	SHORTCUTS,
	type ShortcutId,
	type ShortcutPlatform,
	shortcutById,
	shortcutHint,
	shortcutPlatformFrom,
} from "#/domain/keyboard-shortcuts";
import { useHydrated } from "./first-paint";
import "./keyboard-shortcuts.css";

export function currentShortcutPlatform(): ShortcutPlatform {
	if (typeof navigator === "undefined") return "other";
	const hinted = (navigator as { userAgentData?: { platform?: string } })
		.userAgentData?.platform;
	return shortcutPlatformFrom(hinted || navigator.platform);
}

/** The platform once hydrated; null while the server's markup hydrates (it cannot know). */
export function useShortcutPlatform(): ShortcutPlatform | null {
	const hydrated = useHydrated();
	return hydrated ? currentShortcutPlatform() : null;
}

/** "⌘B" or "Ctrl+B" for a title; empty until hydrated, so the server's title stays valid. */
export function useShortcutHint(id: ShortcutId): string {
	const platform = useShortcutPlatform();
	return platform ? shortcutHint(id, platform) : "";
}

const TERMINAL_SELECTOR = ".xterm, .desktop-stage-rfb";

/** Where a key landed: a text field (empty or not), the terminal or desktop, or the page. */
export function keyFocusOf(target: EventTarget | null): KeyFocus {
	if (!(target instanceof Element)) return "page";
	if (target.closest(TERMINAL_SELECTOR)) return "terminal";
	if (target instanceof HTMLTextAreaElement)
		return target.value ? "filledField" : "emptyField";
	if (target instanceof HTMLInputElement) {
		const nonText = [
			"button",
			"checkbox",
			"radio",
			"range",
			"color",
			"file",
			"submit",
			"reset",
			"image",
		];
		if (nonText.includes(target.type)) return "page";
		return target.value ? "filledField" : "emptyField";
	}
	if (target instanceof HTMLSelectElement) return "filledField";
	if (target instanceof HTMLElement && target.isContentEditable)
		return target.textContent ? "filledField" : "emptyField";
	return "page";
}

/** A bound shortcut's action; `chordIndex` tells Mod+1 from Mod+9. */
export type ShortcutHandler = (chordIndex: number) => void;

export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

const GLOBAL_SHORTCUTS = SHORTCUTS.filter(
	(shortcut) => shortcut.scope === "global",
);

const REPEATING_SHORTCUTS: readonly ShortcutId[] = ["previousChat", "nextChat"];

/**
 * Binds the page's shortcuts on window. A key some element already handled
 * (a menu's Escape, the editor's Cmd+S) is left alone, as is a shortcut
 * without a handler: the browser keeps it.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers) {
	const current = useRef(handlers);
	current.current = handlers;
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			const match = matchShortcut(
				event,
				keyFocusOf(event.target),
				currentShortcutPlatform(),
				GLOBAL_SHORTCUTS,
			);
			const handler = match && current.current[match.shortcut.id];
			if (!match || !handler) return;
			// Held down, only stepping through chats repeats.
			if (event.repeat && !REPEATING_SHORTCUTS.includes(match.shortcut.id)) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			handler(match.chordIndex);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}

function ShortcutKeys({
	id,
	platform,
	all = false,
}: {
	id: ShortcutId;
	platform: ShortcutPlatform;
	/** Every chord ("⌘/ or ?"), not only the first. */
	all?: boolean;
}) {
	const shortcut = shortcutById(id);
	const chords = all
		? shortcut.chords.slice(0, 2)
		: shortcut.chords.slice(0, 1);
	return (
		<span className="shortcut-keys">
			{chords.map((chord, index) => (
				<span key={chordKeys(chord, platform).join("")} className="contents">
					{index > 0 ? <span className="shortcut-keys-alt">or</span> : null}
					{chordKeys(chord, platform, shortcut.displayKey).map((key) => (
						<kbd key={key}>{key}</kbd>
					))}
				</span>
			))}
		</span>
	);
}

export function ShortcutHelpDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const platform = currentShortcutPlatform();
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="shortcut-overlay" />
				<Dialog.Content
					className="shortcut-dialog"
					aria-describedby={undefined}
				>
					<Dialog.Title className="shortcut-dialog-title">
						Keyboard shortcuts
					</Dialog.Title>
					<div className="shortcut-sheet">
						{SHORTCUT_GROUPS.map((group) => (
							<section key={group}>
								<h3>{group}</h3>
								<ul>
									{SHORTCUTS.filter((shortcut) => shortcut.group === group).map(
										(shortcut) => (
											<li key={shortcut.id}>
												<span className="menu-row-label">{shortcut.label}</span>
												<ShortcutKeys
													id={shortcut.id}
													platform={platform}
													all
												/>
											</li>
										),
									)}
								</ul>
							</section>
						))}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export type CommandPaletteItem = {
	readonly id: string;
	readonly group: "Actions" | "Chats" | "Projects";
	readonly label: string;
	/** A chat's project; a quiet second line of the row. */
	readonly detail?: string;
	readonly shortcut?: ShortcutId;
	readonly disabled?: boolean;
	readonly run: () => void;
};

/** Items whose label or detail holds every word typed, in their given order. */
export function commandPaletteMatches(
	items: readonly CommandPaletteItem[],
	query: string,
): CommandPaletteItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		const text = `${item.label} ${item.detail ?? ""}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

export function CommandPalette({
	open,
	onOpenChange,
	items,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	items: readonly CommandPaletteItem[];
}) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const platform = currentShortcutPlatform();
	const shown = useMemo(
		() => commandPaletteMatches(items, query),
		[items, query],
	);
	useEffect(() => {
		if (open) setQuery("");
	}, [open]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: every new query starts at the top.
	useEffect(() => setActiveIndex(0), [query]);
	useEffect(() => {
		listRef.current
			?.querySelector(`[data-index="${activeIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	function run(item: CommandPaletteItem | undefined) {
		if (!item || item.disabled) return;
		onOpenChange(false);
		item.run();
	}

	function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing || !shown.length) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActiveIndex((index) => (index + step + shown.length) % shown.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(shown[activeIndex]);
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="shortcut-overlay" />
				<Dialog.Content
					className="shortcut-dialog command-palette"
					aria-describedby={undefined}
				>
					<Dialog.Title className="sr-only">
						Search chats and actions
					</Dialog.Title>
					<input
						className="command-palette-search"
						aria-label="Search chats and actions"
						placeholder="Search chats and actions…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
						role="combobox"
						aria-expanded="true"
						aria-controls="command-palette-results"
						aria-activedescendant={
							shown[activeIndex] ? `command-palette-${activeIndex}` : undefined
						}
					/>
					<div
						ref={listRef}
						className="command-palette-results"
						id="command-palette-results"
						role="listbox"
					>
						{shown.length === 0 ? (
							<p className="command-palette-empty">No matches.</p>
						) : null}
						{(["Actions", "Chats", "Projects"] as const).map((group) => {
							const rows = shown
								.map((item, index) => ({ item, index }))
								.filter(({ item }) => item.group === group);
							if (!rows.length) return null;
							return (
								<section key={group}>
									<h3 className="command-palette-heading">{group}</h3>
									<div className="command-palette-list">
										{rows.map(({ item, index }) => (
											<button
												key={item.id}
												type="button"
												role="option"
												id={`command-palette-${index}`}
												data-index={index}
												aria-selected={index === activeIndex}
												data-active={index === activeIndex}
												className="command-palette-item"
												disabled={item.disabled}
												tabIndex={-1}
												onPointerMove={() => setActiveIndex(index)}
												onClick={() => run(item)}
											>
												<span className="menu-row-label">{item.label}</span>
												{item.detail ? (
													<span className="command-palette-detail">
														{item.detail}
													</span>
												) : null}
												{item.shortcut ? (
													<ShortcutKeys
														id={item.shortcut}
														platform={platform}
													/>
												) : null}
											</button>
										))}
									</div>
								</section>
							);
						})}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** The sidebar's chats as listed now, top to bottom: rows a fold or a hidden sort view hides are left out. */
export function sidebarChatIdsInOrder(
	root: ParentNode = document,
): readonly string[] {
	const rows = root.querySelectorAll<HTMLElement>(
		"#project-sidebar .sidebar-chat-row[data-chat-id]",
	);
	const ids: string[] = [];
	for (const row of rows) {
		const id = row.dataset.chatId;
		if (!id || ids.includes(id)) continue;
		if (row.checkVisibility && !row.checkVisibility()) continue;
		ids.push(id);
	}
	return ids;
}
