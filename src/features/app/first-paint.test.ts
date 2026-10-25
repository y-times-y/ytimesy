import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
	SIDEBAR_PINNED_CHATS_KEY,
	SIDEBAR_PINNED_STORAGE_KEY,
	SIDEBAR_SORT_KEY,
} from "#/domain/sidebar-chats";
import {
	FIRST_PAINT_SCRIPT,
	type FirstPaintChoices,
	readSavedChoices,
	SERVER_FIRST_PAINT,
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
		__YT_BOOT_STYLES__: undefined as FakeSheet | undefined,
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
	[SIDEBAR_SORT_KEY]: "recent",
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
					[SIDEBAR_SORT_KEY]: "bogus",
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
				sidebarSort: "projects",
			});
			expect(page.document.adoptedStyleSheets).toEqual([]);
		}
	});

	it("shows the saved sidebar, sort, pins and folds before React runs", () => {
		const page = runScript(browser({ stored: saved }));
		expect(page.window.__YT_BOOT__).toEqual({
			compact: false,
			sidebarOpen: true,
			sidebarSort: "recent",
			collapsedProjectIds: ["project-1"],
			pinnedChatIds: ["chat-1", "chat-2"],
		});
		expect(page.document.documentElement.dataset).toEqual({
			sidebar: "open",
			sidebarSort: "recent",
		});
		const [sheet] = page.document.adoptedStyleSheets;
		expect(page.window.__YT_BOOT_STYLES__).toBe(sheet);
		expect(sheet?.text).toBe(
			'.sidebar-chat-row[data-chat-id="chat-1"]{--chat-pinned:1}' +
				'.sidebar-chat-row[data-chat-id="chat-2"]{--chat-pinned:1}' +
				'.sidebar-project[data-project-id="project-1"]{--folder-chats:none;--folder-chevron:none}',
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
