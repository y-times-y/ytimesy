import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	machineCallsInFlight,
	pauseVmWhileThinkingEnabled,
	resumingAfterThinkingPause,
	THINKING_PAUSE_GRACE_MS,
	type ThinkingPauseBlocker,
	type ThinkingPauseFacts,
	type ThinkingPauseTimers,
	thinkingPauseDecision,
	thinkingPauseScheduler,
} from "./thinking-pause";
import type { WorkspaceMachines } from "./workspace-machines";

const quiet: ThinkingPauseFacts = {
	toolsRunning: 0,
	machineCallsRunning: 0,
	canPause: true,
	otherTurnOnMachine: false,
	backgroundCommands: 0,
	desktopViewers: 0,
	terminals: 0,
};

describe("thinkingPauseDecision", () => {
	it("pauses a VM nothing needs", () => {
		expect(thinkingPauseDecision(quiet)).toEqual({ pause: true });
	});

	it.each([
		[{ toolsRunning: 1 }, "tool-running"],
		[{ machineCallsRunning: 1 }, "machine-call-running"],
		[{ canPause: false }, "unsupported"],
		[{ otherTurnOnMachine: true }, "other-turn"],
		[{ backgroundCommands: 2 }, "background-command"],
		[{ desktopViewers: 1 }, "desktop-attached"],
		[{ terminals: 1 }, "terminal-open"],
	] as const)("keeps it running for %o", (change, reason) => {
		expect(thinkingPauseDecision({ ...quiet, ...change })).toEqual({
			pause: false,
			reason,
		});
	});

	it.each([
		"otherTurnOnMachine",
		"backgroundCommands",
		"desktopViewers",
		"terminals",
	] as const)("keeps it running when %s is unknown", (fact) => {
		expect(thinkingPauseDecision({ ...quiet, [fact]: undefined })).toEqual({
			pause: false,
			reason: "unknown",
		});
	});

	it("names a known blocker before an unknown fact after it", () => {
		expect(
			thinkingPauseDecision({
				toolsRunning: 0,
				machineCallsRunning: 0,
				canPause: true,
				otherTurnOnMachine: true,
			}),
		).toEqual({ pause: false, reason: "other-turn" });
	});

	it("is off unless the flag is exactly true", () => {
		expect(pauseVmWhileThinkingEnabled({})).toBe(false);
		expect(
			pauseVmWhileThinkingEnabled({ YTIMESY_PAUSE_VM_WHILE_THINKING: "1" }),
		).toBe(false);
		expect(
			pauseVmWhileThinkingEnabled({ YTIMESY_PAUSE_VM_WHILE_THINKING: "true" }),
		).toBe(true);
	});

	it("waits a grace in the 8-15 s range", () => {
		expect(THINKING_PAUSE_GRACE_MS).toBeGreaterThanOrEqual(8_000);
		expect(THINKING_PAUSE_GRACE_MS).toBeLessThanOrEqual(15_000);
	});
});

/** Manual timers: `fire` runs what is due by the given time. */
function manualTimers() {
	let now = 0;
	let next = 0;
	const due = new Map<number, { at: number; run: () => void }>();
	const timers: ThinkingPauseTimers = {
		set(run, ms) {
			const id = ++next;
			due.set(id, { at: now + ms, run });
			return id;
		},
		clear(handle) {
			due.delete(handle as number);
		},
	};
	return {
		timers,
		now: () => now,
		pending: () => due.size,
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...due])
				if (timer.at <= now) {
					due.delete(id);
					timer.run();
				}
		},
	};
}

let vmCount = 0;
function fakeVm() {
	return WorkspaceId(`vm-thinking-${++vmCount}`);
}

function fakeMachines(events: string[]) {
	return {
		pause: vi.fn(async (vm: WorkspaceId) => {
			events.push(`pause ${vm}`);
		}),
		ensureRunning: vi.fn(async (vm: WorkspaceId) => {
			events.push(`resume ${vm}`);
			return vm;
		}),
		exec: vi.fn(async (vm: WorkspaceId, command: string) => {
			events.push(`exec ${vm} ${command}`);
			return { exitCode: 0, stdout: "", stderr: "" };
		}),
		readTextFile: vi.fn(async (vm: WorkspaceId, path: string) => {
			events.push(`read ${vm} ${path}`);
			return "text";
		}),
	} as unknown as WorkspaceMachines & {
		pause: ReturnType<typeof vi.fn>;
		ensureRunning: ReturnType<typeof vi.fn>;
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type SetupOptions = {
	other?: () => Promise<boolean>;
	background?: () => Promise<number>;
	attachments?: () => Promise<{ viewers: number; terminals: number }>;
};

function setup(options: SetupOptions = {}) {
	const events: string[] = [];
	const lines: Record<string, unknown>[] = [];
	const clock = manualTimers();
	const vm = fakeVm();
	const machines = fakeMachines(events);
	const log = (line: string) => lines.push(JSON.parse(line));
	const scheduler = thinkingPauseScheduler({
		vm: () => vm,
		machines,
		otherTurnOnMachine: options.other ?? (async () => false),
		backgroundCommands: options.background ?? (async () => 0),
		attachments:
			options.attachments ?? (async () => ({ viewers: 0, terminals: 0 })),
		timers: clock.timers,
		now: clock.now,
		log,
	});
	const resuming = resumingAfterThinkingPause(machines, {
		now: clock.now,
		log,
	});
	return { events, lines, clock, vm, machines, scheduler, resuming };
}

describe("thinkingPauseScheduler", () => {
	afterEach(() => vi.restoreAllMocks());

	it("pauses after the grace once the last tool call returned", async () => {
		const { clock, machines, scheduler, lines, vm } = setup();
		scheduler.toolStarted("a");
		scheduler.toolStarted("b");
		scheduler.toolEnded("a");
		expect(clock.pending()).toBe(0);
		clock.advance(1_000);
		scheduler.toolEnded("b");
		clock.advance(THINKING_PAUSE_GRACE_MS - 1);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
		clock.advance(1);
		await flush();
		expect(machines.pause).toHaveBeenCalledWith(vm);
		expect(lines).toContainEqual({
			event: "vm.paused_thinking",
			vm,
			idleMs: THINKING_PAUSE_GRACE_MS,
		});
	});

	it("cancels the grace when a new tool call starts", async () => {
		const { clock, machines, scheduler } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS - 1);
		scheduler.toolStarted("b");
		clock.advance(THINKING_PAUSE_GRACE_MS * 3);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
		expect(clock.pending()).toBe(0);
	});

	it("drops a check overtaken by a tool call", async () => {
		let answer: (value: boolean) => void = () => {};
		const { clock, machines, scheduler } = setup({
			other: () =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		});
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		scheduler.toolStarted("b");
		answer(false);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
	});

	it("never pauses after the step ended", async () => {
		const { clock, machines, scheduler } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		scheduler.dispose();
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
	});

	it.each<[string, SetupOptions, ThinkingPauseBlocker]>([
		["another turn uses the VM", { other: async () => true }, "other-turn"],
		[
			"a background command runs",
			{ background: async () => 1 },
			"background-command",
		],
		[
			"a desktop viewer is attached",
			{ attachments: async () => ({ viewers: 1, terminals: 0 }) },
			"desktop-attached",
		],
		[
			"a terminal is open",
			{ attachments: async () => ({ viewers: 0, terminals: 1 }) },
			"terminal-open",
		],
		[
			"a check fails",
			{
				background: async (): Promise<number> => {
					throw new Error("guest did not answer");
				},
			},
			"unknown",
		],
	])("keeps the VM running when %s", async (_, options, reason) => {
		const { clock, machines, scheduler, lines, vm } = setup(options);
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
		expect(lines).toContainEqual({
			event: "vm.pause_thinking_skipped",
			vm,
			reason,
		});
	});

	it("stops checking at the first blocker", async () => {
		const background = vi.fn(async () => 0);
		const { clock, scheduler } = setup({ other: async () => true, background });
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		expect(background).not.toHaveBeenCalled();
	});

	it("keeps the VM running while a guest operation is in flight", async () => {
		const { clock, machines, scheduler, resuming, vm } = setup();
		let finish: () => void = () => {};
		(machines.exec as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
				}),
		);
		const running = resuming.exec(vm, "sleep 30");
		await flush();
		expect(machineCallsInFlight(vm)).toBe(1);
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		expect(machines.pause).not.toHaveBeenCalled();
		finish();
		await running;
		expect(machineCallsInFlight(vm)).toBe(0);
	});
});

describe("resumingAfterThinkingPause", () => {
	it("resumes a VM paused for thinking before the next guest operation", async () => {
		const { clock, events, scheduler, resuming, lines, vm } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		clock.advance(30_000);
		events.length = 0;
		await resuming.exec(vm, "git status");
		await resuming.readTextFile(vm, "/x");
		expect(events).toEqual([
			`resume ${vm}`,
			`exec ${vm} git status`,
			`read ${vm} /x`,
		]);
		expect(lines).toContainEqual({
			event: "vm.resumed_for_tool",
			vm,
			resumeMs: 0,
			pausedMs: 30_000,
		});
	});

	it("waits for a pause in progress, then resumes", async () => {
		const { clock, events, machines, scheduler, resuming, vm } = setup();
		let land: () => void = () => {};
		machines.pause.mockImplementationOnce(
			(paused: WorkspaceId) =>
				new Promise<void>((resolve) => {
					land = () => {
						events.push(`pause ${paused}`);
						resolve();
					};
				}),
		);
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		const exec = resuming.exec(vm, "ls");
		await flush();
		expect(events).toEqual([]);
		land();
		await exec;
		expect(events).toEqual([`pause ${vm}`, `resume ${vm}`, `exec ${vm} ls`]);
	});

	it("shares one resume between concurrent operations", async () => {
		const { clock, machines, scheduler, resuming, vm } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		await Promise.all([
			resuming.exec(vm, "a"),
			resuming.exec(vm, "b"),
			resuming.readTextFile(vm, "/c"),
		]);
		expect(machines.ensureRunning).toHaveBeenCalledTimes(1);
	});

	it("leaves a VM it did not pause to the operation's own path", async () => {
		const { machines, resuming, vm } = setup();
		await resuming.exec(vm, "true");
		expect(machines.ensureRunning).not.toHaveBeenCalled();
	});

	it("does not run the operation when the resume fails, and retries next time", async () => {
		const { clock, events, machines, scheduler, resuming, vm } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		machines.ensureRunning.mockRejectedValueOnce(new Error("provider down"));
		await expect(resuming.exec(vm, "x")).rejects.toThrow("provider down");
		expect(events).not.toContain(`exec ${vm} x`);
		await resuming.exec(vm, "y");
		expect(machines.ensureRunning).toHaveBeenCalledTimes(2);
		expect(events).toContain(`exec ${vm} y`);
	});

	it("does not pause again a VM already paused for thinking", async () => {
		const { clock, machines, scheduler } = setup();
		scheduler.toolStarted("a");
		scheduler.toolEnded("a");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		scheduler.toolStarted("b");
		scheduler.toolEnded("b");
		clock.advance(THINKING_PAUSE_GRACE_MS);
		await flush();
		expect(machines.pause).toHaveBeenCalledTimes(1);
	});
});
