import { describe, expect, it } from "vitest";
import { initialSetupMessageId } from "./environment-setup";
import {
	backgroundSetupLine,
	projectSetupChat,
	startsBackgroundProjectSetup,
} from "./project-setup-start";

const building = { projectId: "p1", status: "cloning", build: null };
const ready = { ...building, status: "ready" };

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

describe("startsBackgroundProjectSetup", () => {
	const base = {
		projectId: "p1",
		workspace: building,
		chats: [] as { unused?: boolean }[],
		startedInThisTab: new Set<string>(),
		sawFirstBuildInThisTab: new Set<string>(),
		taskSent: false,
	};

	it("starts while the first build runs, the open empty chat staying the person's", () => {
		for (const status of ["queued", "provisioning", "cloning", "installing"])
			expect(
				startsBackgroundProjectSetup({
					...base,
					workspace: { ...building, status },
				}),
			).toBe(true);
		// The open empty chat is listed as unused: it is not in use.
		expect(
			startsBackgroundProjectSetup({ ...base, chats: [{ unused: true }] }),
		).toBe(true);
	});

	it("starts once the build is ready only when this tab saw it running", () => {
		expect(startsBackgroundProjectSetup({ ...base, workspace: ready })).toBe(
			false,
		);
		expect(
			startsBackgroundProjectSetup({
				...base,
				workspace: ready,
				sawFirstBuildInThisTab: new Set(["p1"]),
			}),
		).toBe(true);
	});

	it("never starts over a task, a chat in use, a second time, a rebuild or a failed build", () => {
		expect(startsBackgroundProjectSetup({ ...base, taskSent: true })).toBe(
			false,
		);
		expect(startsBackgroundProjectSetup({ ...base, chats: [{}] })).toBe(false);
		// Chats still loading: not yet known to have none.
		expect(startsBackgroundProjectSetup({ ...base, chats: undefined })).toBe(
			false,
		);
		expect(
			startsBackgroundProjectSetup({
				...base,
				startedInThisTab: new Set(["p1"]),
			}),
		).toBe(false);
		expect(
			startsBackgroundProjectSetup({
				...base,
				workspace: { ...building, build: { rebuild: true } },
			}),
		).toBe(false);
		expect(
			startsBackgroundProjectSetup({
				...base,
				workspace: { ...building, status: "failed" },
				sawFirstBuildInThisTab: new Set(["p1"]),
			}),
		).toBe(false);
		// Another project's status says nothing about this one.
		expect(
			startsBackgroundProjectSetup({
				...base,
				workspace: { ...building, projectId: "p2" },
			}),
		).toBe(false);
	});
});

describe("backgroundSetupLine", () => {
	const setupChat = {
		id: "setup",
		title: "Set up project",
		turnStatus: "idle",
		waitsForSetup: true,
	};

	it("shows one line while the first build runs, with View once the setup chat exists", () => {
		expect(
			backgroundSetupLine({
				workspace: building,
				setupChat: null,
				openChatId: "task",
			}),
		).toEqual({
			text: "Setting up this project in the background",
			chatId: null,
		});
		expect(
			backgroundSetupLine({
				workspace: building,
				setupChat,
				openChatId: "task",
			}),
		).toEqual({
			text: "Setting up this project in the background",
			chatId: "setup",
		});
	});

	it("keeps the line while the setup chat works or needs the person, after the build", () => {
		expect(
			backgroundSetupLine({
				workspace: ready,
				setupChat: {
					...setupChat,
					waitsForSetup: false,
					turnStatus: "running",
				},
				openChatId: "task",
			})?.text,
		).toBe("Setting up this project in the background");
		expect(
			backgroundSetupLine({
				workspace: ready,
				setupChat: {
					...setupChat,
					waitsForSetup: false,
					waitingOn: "secret",
				},
				openChatId: undefined,
			}),
		).toEqual({ text: "Project setup needs you", chatId: "setup" });
	});

	it("shows nothing once setup is done, in the setup chat itself, or after a failed build", () => {
		const done = {
			...setupChat,
			waitsForSetup: false,
			turnStatus: "completed",
		};
		expect(
			backgroundSetupLine({
				workspace: ready,
				setupChat: done,
				openChatId: "task",
			}),
		).toBeNull();
		expect(
			backgroundSetupLine({
				workspace: building,
				setupChat,
				openChatId: "setup",
			}),
		).toBeNull();
		expect(
			backgroundSetupLine({
				workspace: { ...building, status: "failed" },
				setupChat,
				openChatId: "task",
			}),
		).toBeNull();
		// A rebuild of a working environment is not the project's setup.
		expect(
			backgroundSetupLine({
				workspace: { ...building, build: { rebuild: true } },
				setupChat: null,
				openChatId: "task",
			}),
		).toBeNull();
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
