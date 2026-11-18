import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPOSER_DRAFTS_KEY,
	DRAFT_MAX_AGE_MS,
	storageWithDraft,
} from "#/domain/composer-drafts";
import {
	CHAT_SEEN_SINCE_STORAGE_KEY,
	CHAT_SEEN_STORAGE_KEY,
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
	SIDEBAR_PINNED_CHATS_KEY,
	SIDEBAR_PINNED_STORAGE_KEY,
} from "#/domain/sidebar-chats";
import {
	COMPOSER_DRAFT_SCRIPT,
	FIRST_PAINT_ROWS_SCRIPT,
	FIRST_PAINT_SCRIPT,
	type FirstPaintChoices,
	readSavedChoices,
	SERVER_FIRST_PAINT,
	TIMELINE_END_SCRIPT,
} from "./first-paint";

class FakeSheet {
	text = "";
	replaceSync(text: string) {
		this.text = text;
	}
}

function browser(input: {
	stored?: Record<string, string>;
	phone?: boolean;
	storageThrows?: boolean;
}) {
	const window = {
		localStorage: {
			getItem: (key: string) => {
				if (input.storageThrows) throw new Error("SecurityError");
				return input.stored?.[key] ?? null;
			},
		},
		matchMedia: () => ({ matches: Boolean(input.phone) }),
		__YT_BOOT__: undefined as FirstPaintChoices | undefined,
		__YT_BOOT_STYLES__: undefined as FakeSheet[] | undefined,
	};
	const document = {
		documentElement: { dataset: {} as Record<string, string> },
		adoptedStyleSheets: [] as FakeSheet[],
	};
	return { window, document };
}

/** Runs the inline script the way the page does: no module scope, only globals. */
function runScript(page: ReturnType<typeof browser>) {
	runInNewContext(FIRST_PAINT_SCRIPT, {
		window: page.window,
		document: page.document,
		CSSStyleSheet: FakeSheet,
	});
	return page;
}

/** What React's useState initializers read after hydration, in the same browser. */
function readInComponent(page: ReturnType<typeof browser>) {
	(globalThis as { window?: unknown }).window = page.window;
	return readSavedChoices();
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
});

const saved = {
	[SIDEBAR_PINNED_STORAGE_KEY]: "1",
	[SIDEBAR_COLLAPSED_PROJECTS_KEY]: JSON.stringify(["project-1"]),
	[SIDEBAR_PINNED_CHATS_KEY]: JSON.stringify(["chat-1", "chat-2"]),
};

describe("first-paint script", () => {
	it("runs with no outer scope", () => {
		expect(() => runScript(browser({}))).not.toThrow();
	});

	it("hands React the same choices the components read", () => {
		for (const input of [
			{},
			{ stored: saved },
			{ stored: saved, phone: true },
			{
				stored: {
					[SIDEBAR_PINNED_CHATS_KEY]: "{",
				},
			},
			{ stored: saved, storageThrows: true },
		]) {
			const page = runScript(browser(input));
			expect(page.window.__YT_BOOT__).toEqual(readInComponent(page));
		}
	});

	it("falls back to what the server renders when nothing is saved or storage is blocked", () => {
		for (const input of [{}, { stored: saved, storageThrows: true }]) {
			const page = runScript(browser(input));
			expect(page.window.__YT_BOOT__).toEqual(SERVER_FIRST_PAINT);
			expect(page.document.documentElement.dataset).toEqual({
				sidebar: "closed",
			});
			expect(page.document.adoptedStyleSheets).toEqual([]);
		}
	});

	it("shows the saved sidebar, pins and folds before React runs", () => {
		const page = runScript(browser({ stored: saved }));
		expect(page.window.__YT_BOOT__).toEqual({
			compact: false,
			sidebarOpen: true,
			collapsedProjectIds: ["project-1"],
			pinnedChatIds: ["chat-1", "chat-2"],
		});
		expect(page.document.documentElement.dataset).toEqual({
			sidebar: "open",
		});
		const [sheet] = page.document.adoptedStyleSheets;
		expect(page.window.__YT_BOOT_STYLES__).toEqual([sheet]);
		expect(sheet?.text).toBe(
			'.sidebar-chat-row[data-chat-id="chat-1"]{--chat-pinned:1}' +
				'.sidebar-chat-row[data-chat-id="chat-2"]{--chat-pinned:1}' +
				'.sidebar-plain-section[data-project-id="project-1"]{--section-body:none;--section-chevron:none}',
		);
	});

	it("keeps a phone's sidebar closed even when pinned", () => {
		const page = runScript(browser({ stored: saved, phone: true }));
		expect(page.window.__YT_BOOT__?.sidebarOpen).toBe(false);
		expect(page.document.documentElement.dataset.sidebar).toBe("closed");
	});

	it("never writes a stored id that is not a plain id into CSS", () => {
		const page = runScript(
			browser({
				stored: {
					[SIDEBAR_PINNED_CHATS_KEY]: JSON.stringify(['x"]{}*{color:red}']),
				},
			}),
		);
		expect(page.document.adoptedStyleSheets).toEqual([]);
	});
});

type FakeRow = { dataset: Record<string, string | undefined> };

/** The rows script against a page whose selectors return these rows. */
function runRowsScript(input: {
	stored?: Record<string, string>;
	pinnedChatIds?: readonly string[];
	rows: Record<string, FakeRow[]>;
	/** A later streamed copy of the sidebar, whose script runs after. */
	laterCopy?: Record<string, FakeRow[]>;
}) {
	const page = browser({ stored: input.stored });
	page.window.__YT_BOOT__ = {
		...SERVER_FIRST_PAINT,
		pinnedChatIds: input.pinnedChatIds ?? [],
	};
	const document = { ...page.document, currentScript: {} };
	for (const rows of [input.rows, input.laterCopy]) {
		if (!rows) continue;
		document.currentScript = {
			previousElementSibling: {
				querySelectorAll: (selector: string) => rows[selector] ?? [],
			},
		};
		runInNewContext(FIRST_PAINT_ROWS_SCRIPT, {
			window: page.window,
			document,
			CSSStyleSheet: FakeSheet,
		});
	}
	return document.adoptedStyleSheets.map((sheet) => sheet.text).join("");
}

const UNREAD_ROWS = "[data-unread-mark]";
const PLAIN_SECTIONS = ".sidebar-plain-section";
const section = (id: string): FakeRow => ({ dataset: { projectId: id } });
const plainDoneRows = (id: string) =>
	`.sidebar-plain-section[data-project-id="${id}"] .sidebar-chat-row[data-group="done"]`;
const THREADS_DONE_ROWS =
	'.sidebar-threads-section .sidebar-chat-row[data-group="done"]';
const reply = (id: string, updatedAt: string): FakeRow => ({
	dataset: {
		chatId: id,
		seenKey: `${id}:completed:${updatedAt}`,
		updatedAt,
		unreadMark: "true",
	},
});

describe("first-paint rows script", () => {
	const seenSince = {
		[CHAT_SEEN_SINCE_STORAGE_KEY]: String(Date.parse("2026-10-01T00:00:00Z")),
	};

	it("marks replies newer than this browser's seen chats", () => {
		const fresh = reply("fresh", "2026-10-20T00:00:00Z");
		const old = reply("old", "2026-09-01T00:00:00Z");
		const css = runRowsScript({
			stored: seenSince,
			rows: { [UNREAD_ROWS]: [fresh, old] },
		});
		expect(css).toContain(
			'.sidebar-chat-row[data-chat-id="fresh"][data-unread-mark] .sidebar-chat-age{display:none}',
		);
		expect(css).not.toContain('data-chat-id="old"');
		expect(css).not.toContain("left-sidebar-toggle");
	});

	it("keeps only the marks of a later streamed copy of the sidebar", () => {
		const fresh = reply("fresh", "2026-10-20T00:00:00Z");
		const css = runRowsScript({
			stored: seenSince,
			rows: { [UNREAD_ROWS]: [fresh] },
			// The copy with the chat open: an open chat is never unread.
			laterCopy: {},
		});
		expect(css).toBe("");
	});

	it("leaves seen replies, and every reply when nothing was tracked yet", () => {
		const fresh = reply("fresh", "2026-10-20T00:00:00Z");
		const seen = {
			...seenSince,
			[CHAT_SEEN_STORAGE_KEY]: JSON.stringify([fresh.dataset.seenKey]),
		};
		for (const stored of [seen, {}])
			expect(
				runRowsScript({
					stored,
					rows: { [UNREAD_ROWS]: [fresh] },
				}),
			).toBe("");
	});

	it("shows a saved pin past a plain project's Settled fold, each section on its own", () => {
		const row = (id: string, overflow = false): FakeRow => ({
			dataset: { chatId: id, doneOverflow: overflow ? "true" : undefined },
		});
		const css = runRowsScript({
			pinnedChatIds: ["late"],
			rows: {
				[PLAIN_SECTIONS]: [section("one"), section("two")],
				[plainDoneRows("one")]: [row("a"), row("b"), row("late", true)],
				[plainDoneRows("two")]: [row("c"), row("d")],
			},
		});
		// The other project's rows are not counted into this fold.
		expect(css).toBe(
			'.sidebar-plain-section[data-project-id="one"] [data-chat-id="b"]{display:none}' +
				'.sidebar-plain-section[data-project-id="one"] [data-chat-id="late"]{display:flex}',
		);
	});

	it("folds the Threads section's Settled apart from the plain chats' Done", () => {
		const row = (id: string, overflow = false): FakeRow => ({
			dataset: { chatId: id, doneOverflow: overflow ? "true" : undefined },
		});
		const css = runRowsScript({
			pinnedChatIds: ["late"],
			rows: {
				[THREADS_DONE_ROWS]: [row("a"), row("b"), row("late", true)],
				[PLAIN_SECTIONS]: [section("one")],
				[plainDoneRows("one")]: [row("p1"), row("p2")],
			},
		});
		expect(css).toBe(
			'.sidebar-threads-section [data-chat-id="b"]{display:none}' +
				'.sidebar-threads-section [data-chat-id="late"]{display:flex}',
		);
	});

	it("shows a saved pin past the Settled fold of the Threads section", () => {
		const row = (id: string, overflow = false): FakeRow => ({
			dataset: {
				chatId: id,
				doneOverflow: overflow ? "true" : undefined,
			},
		});
		const css = runRowsScript({
			pinnedChatIds: ["late"],
			rows: {
				[THREADS_DONE_ROWS]: [row("a"), row("b"), row("late", true)],
			},
		});
		expect(css).toBe(
			'.sidebar-threads-section [data-chat-id="b"]{display:none}' +
				'.sidebar-threads-section [data-chat-id="late"]{display:flex}',
		);
	});

	it("asks for the Threads section's rows by data-group, not the old nested branch", () => {
		expect(FIRST_PAINT_ROWS_SCRIPT).toContain(".sidebar-threads-section");
		expect(FIRST_PAINT_ROWS_SCRIPT).toMatch(
			/\.sidebar-chat-row\[data-group=\\?"done\\?"\]/,
		);
		expect(FIRST_PAINT_ROWS_SCRIPT).not.toContain("sidebar-y2");
		expect(FIRST_PAINT_SCRIPT).not.toContain("--y2-");
	});
});

describe("transcript end script", () => {
	it("runs with no outer scope and scrolls the list before it to its end", () => {
		const scrolled: unknown[] = [];
		const list = {
			addEventListener: () => undefined,
			lastElementChild: {
				scrollIntoView: (options: unknown) => scrolled.push(options),
			},
		};
		runInNewContext(TIMELINE_END_SCRIPT, {
			document: { currentScript: { previousElementSibling: list } },
			window: { addEventListener: () => undefined },
		});
		expect(scrolled).toEqual([{ block: "end" }]);
	});
});

describe("transcript end script, as fonts and images load", () => {
	function page() {
		const scrolled: unknown[] = [];
		const listeners: Record<string, () => void> = {};
		const list = {
			clientHeight: 600,
			addEventListener: (type: string, listener: () => void) => {
				listeners[type] = listener;
			},
			lastElementChild: { scrollIntoView: () => scrolled.push("end") },
		};
		let onLoad: () => void = () => undefined;
		runInNewContext(TIMELINE_END_SCRIPT, {
			document: {
				currentScript: { previousElementSibling: list },
				readyState: "complete",
			},
			window: {
				addEventListener: (_type: string, listener: () => void) => {
					onLoad = listener;
				},
			},
		});
		return { scrolled, listeners, load: () => onLoad() };
	}

	it("keeps the end in view however the browser moved scrollTop", () => {
		const { scrolled, load } = page();
		load();
		expect(scrolled).toEqual(["end", "end"]);
	});

	it("stops once the reader scrolls", () => {
		const { scrolled, listeners, load } = page();
		listeners.wheel?.();
		load();
		expect(scrolled).toEqual(["end"]);
	});
});

describe("composer draft script", () => {
	class FakeTextarea {
		value = "";
		scrollHeight = 80;
		style: Record<string, string> = {};
		dataset: Record<string, string> = { draftKey: "chat-1" };
		listeners: Record<string, () => void> = {};
		addEventListener(type: string, listener: () => void) {
			this.listeners[type] = listener;
		}
	}
	function run(stored: string | null, typed = "") {
		const input = new FakeTextarea();
		input.value = typed;
		runInNewContext(COMPOSER_DRAFT_SCRIPT, {
			window: {
				localStorage: {
					getItem: (key: string) =>
						key === COMPOSER_DRAFTS_KEY ? stored : null,
				},
			},
			document: { currentScript: { previousElementSibling: input } },
			HTMLTextAreaElement: FakeTextarea,
			Date,
		});
		return input;
	}
	const saved = storageWithDraft(
		null,
		"chat-1",
		"line one\nline two",
		Date.now(),
		DRAFT_MAX_AGE_MS,
	);

	it("fills in and sizes the saved draft of the textarea's chat", () => {
		const input = run(saved);
		expect(input.value).toBe("line one\nline two");
		expect(input.style.height).toBe("80px");
		expect(input.dataset.expanded).toBe("true");
		expect(input.dataset.hasText).toBe("");
	});

	it("marks the textarea while it holds text, as typed before hydration", () => {
		const input = run(null);
		expect(input.dataset.hasText).toBeUndefined();
		input.value = "typed";
		input.listeners.input?.();
		expect(input.dataset.hasText).toBe("");
		input.value = " ";
		input.listeners.input?.();
		expect(input.dataset.hasText).toBeUndefined();
	});

	it("leaves text typed already, and other chats' drafts", () => {
		expect(run(saved, "typed").value).toBe("typed");
		const other = storageWithDraft(
			null,
			"chat-2",
			"x",
			Date.now(),
			DRAFT_MAX_AGE_MS,
		);
		expect(run(other).value).toBe("");
		expect(run(null).style.height).toBeUndefined();
	});
});
