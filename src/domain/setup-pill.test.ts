import { describe, expect, it } from "vitest";
import {
	activeSetupPill,
	readyShownUntil,
	SETUP_READY_SHOWN_MS,
	SETUP_RUNNING_PLACEHOLDER,
	setupComposerPlaceholder,
	setupPillForChat,
} from "./setup-pill";

const now = Date.parse("2026-11-03T12:01:07Z");
const building = { status: "installing", build: null };
const ready = { status: "ready", build: null };
const build = {
	status: "running" as const,
	startedAt: "2026-11-03T12:00:00Z",
};
const steps = [
	{ label: "Starting machine", state: "done" },
	{ label: "Cloning acme/web", state: "done" },
	{ label: "Installing dependencies", state: "running" },
];
const setupChat = { id: "setup", turnStatus: "idle", waitsForSetup: true };

describe("activeSetupPill", () => {
	it("runs with the build's current step and the time since it started", () => {
		expect(
			activeSetupPill({ workspace: building, build, steps, setupChat, now }),
		).toEqual({
			kind: "running",
			text: "Setting up · Installing dependencies",
			elapsed: "1m 07s",
		});
		// Before the steps are read.
		expect(
			activeSetupPill({
				workspace: building,
				build: null,
				steps: [],
				setupChat: null,
				now,
			}),
		).toEqual({
			kind: "running",
			text: "Setting up · Starting",
			elapsed: null,
		});
	});

	it("keeps running while the setup agent works after the build", () => {
		expect(
			activeSetupPill({
				workspace: ready,
				build: null,
				steps: [],
				setupChat: { id: "setup", turnStatus: "running" },
				now,
			})?.text,
		).toBe("Setting up · Checking the project");
	});

	it("needs the person when the setup chat waits on them", () => {
		expect(
			activeSetupPill({
				workspace: ready,
				build: null,
				steps: [],
				setupChat: { id: "setup", turnStatus: "idle", waitingOn: "secret" },
				now,
			}),
		).toEqual({ kind: "needs-you", text: "Setup needs a secret" });
		expect(
			activeSetupPill({
				workspace: ready,
				build: null,
				steps: [],
				setupChat: { id: "setup", waitingOn: "question" },
				now,
			})?.text,
		).toBe("Setup needs you");
	});

	it("says a failed setup failed", () => {
		expect(
			activeSetupPill({
				workspace: { status: "failed", build: null },
				build: null,
				steps: [],
				setupChat,
				now,
			}),
		).toEqual({ kind: "failed", text: "Setup failed" });
	});

	it("shows nothing once setup is done, nor for a rebuild", () => {
		for (const chat of [
			null,
			{ id: "setup", turnStatus: "completed" },
			{ id: "setup", turnStatus: "failed", waitingOn: "failed" as const },
		])
			expect(
				activeSetupPill({
					workspace: ready,
					build: null,
					steps: [],
					setupChat: chat,
					now,
				}),
			).toBeNull();
		expect(
			activeSetupPill({
				workspace: { status: "installing", build: { rebuild: true } },
				build,
				steps,
				setupChat: null,
				now,
			}),
		).toBeNull();
	});
});

describe("Ready, then gone", () => {
	it("shows Ready for a moment once an active pill goes away, then nothing", () => {
		const until = readyShownUntil({
			previous: "running",
			next: null,
			current: null,
			now,
		});
		expect(until).toBe(now + SETUP_READY_SHOWN_MS);
		const shown = (at: number) =>
			setupPillForChat({
				active: null,
				readyUntil: until,
				now: at,
				setupChatId: "setup",
				openChatId: "task",
			});
		expect(shown(now + 1_000)).toEqual({ kind: "ready", text: "Ready" });
		expect(shown(now + SETUP_READY_SHOWN_MS)).toBeNull();
		expect(
			readyShownUntil({
				previous: "needs-you",
				next: null,
				current: null,
				now,
			}),
		).toBe(now + SETUP_READY_SHOWN_MS);
	});

	it("never says Ready for a project that was not set up here, nor after a failure", () => {
		expect(
			readyShownUntil({ previous: null, next: null, current: null, now }),
		).toBeNull();
		expect(
			readyShownUntil({ previous: "failed", next: null, current: null, now }),
		).toBeNull();
		// Active again (a retry): no Ready.
		expect(
			readyShownUntil({
				previous: "ready",
				next: "running",
				current: now + 3_000,
				now,
			}),
		).toBeNull();
	});
});

describe("setupPillForChat", () => {
	const running = {
		kind: "running" as const,
		text: "Setting up · Installing dependencies",
		elapsed: "1m 07s",
	};

	it("never shows in the setup chat itself, Ready included", () => {
		for (const active of [running, null])
			expect(
				setupPillForChat({
					active,
					readyUntil: now + 1_000,
					now,
					setupChatId: "setup",
					openChatId: "setup",
				}),
			).toBeNull();
	});

	it("shows in the person's chats and in a new empty chat", () => {
		for (const openChatId of ["task", undefined])
			expect(
				setupPillForChat({
					active: running,
					readyUntil: null,
					now,
					setupChatId: "setup",
					openChatId,
				}),
			).toBe(running);
	});
});

describe("setupComposerPlaceholder", () => {
	it("tells the person setup keeps running while it runs or waits on them", () => {
		expect(
			setupComposerPlaceholder({
				kind: "running",
				text: "Setting up · Starting",
				elapsed: null,
			}),
		).toBe(SETUP_RUNNING_PLACEHOLDER);
		expect(
			setupComposerPlaceholder({ kind: "needs-you", text: "Setup needs you" }),
		).toBe("Describe a task. Setup keeps running in the background.");
	});

	it("keeps the usual placeholder otherwise (no pill, as in the setup chat; Ready; failed)", () => {
		expect(setupComposerPlaceholder(null)).toBeNull();
		expect(
			setupComposerPlaceholder({ kind: "ready", text: "Ready" }),
		).toBeNull();
		expect(
			setupComposerPlaceholder({ kind: "failed", text: "Setup failed" }),
		).toBeNull();
	});
});
