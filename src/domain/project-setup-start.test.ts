import { describe, expect, it } from "vitest";
import { initialSetupMessageId } from "./environment-setup";
import {
	projectSetupChat,
	SETUP_RUNNING_PLACEHOLDER,
	setupComposerPlaceholder,
	setupIndicator,
} from "./project-setup-start";

const building = { status: "cloning", build: null };
const ready = { status: "ready", build: null };
const setupChat = {
	id: "setup",
	title: "Set up project",
	turnStatus: "idle",
	waitsForSetup: true,
};

describe("setupComposerPlaceholder", () => {
	it("tells the person in their own chat that setup keeps running", () => {
		for (const [workspace, chat] of [
			[building, null],
			[building, setupChat],
			[ready, { ...setupChat, waitsForSetup: false, turnStatus: "running" }],
			[
				ready,
				{ ...setupChat, waitsForSetup: false, waitingOn: "secret" as const },
			],
		] as const)
			for (const openChatId of ["task", undefined])
				expect(
					setupComposerPlaceholder({
						workspace,
						setupChat: chat,
						openChatId,
					}),
				).toBe(SETUP_RUNNING_PLACEHOLDER);
	});

	it("keeps the usual placeholder in the setup chat, once setup is done, after a failed build and during a rebuild", () => {
		const done = {
			...setupChat,
			waitsForSetup: false,
			turnStatus: "completed",
		};
		expect(
			setupComposerPlaceholder({
				workspace: building,
				setupChat,
				openChatId: "setup",
			}),
		).toBeNull();
		expect(
			setupComposerPlaceholder({
				workspace: ready,
				setupChat: done,
				openChatId: "task",
			}),
		).toBeNull();
		expect(
			setupComposerPlaceholder({
				workspace: { status: "failed", build: null },
				setupChat,
				openChatId: "task",
			}),
		).toBeNull();
		expect(
			setupComposerPlaceholder({
				workspace: { status: "installing", build: { rebuild: true } },
				setupChat: null,
				openChatId: "task",
			}),
		).toBeNull();
		expect(
			setupComposerPlaceholder({
				workspace: null,
				setupChat,
				openChatId: "task",
			}),
		).toBeNull();
	});
});

describe("initialSetupMessageId", () => {
	it("is one UUID per project, the same in every tab", () => {
		const id = initialSetupMessageId("6f0c8a3e-1b2d-4c5e-8f90-123456789abc");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(initialSetupMessageId("6f0c8a3e-1b2d-4c5e-8f90-123456789abc")).toBe(
			id,
		);
		expect(initialSetupMessageId("another-project")).not.toBe(id);
	});
});

it("finds the project's setup chat by its title, the newest first", () => {
	expect(
		projectSetupChat([
			{ id: "task", title: "Add a login page" },
			{ id: "new", title: "Set up project" },
			{ id: "old", title: "Set up environment" },
		])?.id,
	).toBe("new");
	expect(projectSetupChat([{ id: "task", title: "Add" }])).toBeNull();
	expect(projectSetupChat(undefined)).toBeNull();
});

describe("setupIndicator", () => {
	it("says setup runs in another chat, with View setup once that chat exists", () => {
		expect(
			setupIndicator({
				workspace: building,
				setupChat: null,
				openChatId: "task",
			}),
		).toEqual({
			kind: "running",
			text: "Setup is running in another chat. You can send now.",
			action: "View setup",
			chatId: null,
		});
		expect(
			setupIndicator({
				workspace: ready,
				setupChat: {
					...setupChat,
					waitsForSetup: false,
					turnStatus: "running",
				},
				openChatId: undefined,
			})?.chatId,
		).toBe("setup");
	});

	it("says when setup needs a secret, with Open", () => {
		expect(
			setupIndicator({
				workspace: ready,
				setupChat: { ...setupChat, waitsForSetup: false, waitingOn: "secret" },
				openChatId: "task",
			}),
		).toEqual({
			kind: "needs-you",
			text: "Setup needs a secret",
			action: "Open",
			chatId: "setup",
		});
	});

	it("is gone once setup finishes, in the setup chat itself, and after a failed build", () => {
		const done = {
			...setupChat,
			waitsForSetup: false,
			turnStatus: "completed",
		};
		expect(
			setupIndicator({ workspace: ready, setupChat: done, openChatId: "task" }),
		).toBeNull();
		expect(
			setupIndicator({ workspace: building, setupChat, openChatId: "setup" }),
		).toBeNull();
		expect(
			setupIndicator({
				workspace: { status: "failed", build: null },
				setupChat,
				openChatId: "task",
			}),
		).toBeNull();
	});
});
