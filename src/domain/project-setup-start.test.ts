import { describe, expect, it } from "vitest";
import { initialSetupMessageId } from "./environment-setup";
import {
	projectSetupChat,
	SETUP_RUNNING_PLACEHOLDER,
	setupComposerPlaceholder,
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
