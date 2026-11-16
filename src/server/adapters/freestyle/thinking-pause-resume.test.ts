import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { resumingAfterThinkingPause } from "#/server/services/thinking-pause";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

/** One VM whose state follows pause and start, like the provider's. */
const provider = vi.hoisted(() => ({
	state: "running" as "running" | "paused",
	calls: [] as string[],
}));
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const vm = {
		id: "vm-thinking",
		data: async () => ({
			id: "vm-thinking",
			state: provider.state,
			resources: { cpu: 4, memory: 16384, storage: 32768 },
			metadata: {},
			idleTimeoutSeconds: 60,
			autoDeleteSeconds: 30 * 24 * 60 * 60,
		}),
		update: async () => undefined,
		pause: async () => {
			provider.calls.push("pause");
			provider.state = "paused";
		},
		start: async () => {
			provider.calls.push("start");
			provider.state = "running";
		},
		exec: async ({ command }: { command: string }) => {
			if (provider.state !== "running") throw new Error("exec on a paused VM");
			provider.calls.push(`exec ${command}`);
			return { statusCode: 0, stdout: "", stderr: "" };
		},
	};
	return {
		...actual,
		Freestyle: class {
			vms = { ref: () => vm };
		},
	};
});

beforeEach(() => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.state = "running";
	provider.calls = [];
});
afterEach(() => vi.unstubAllEnvs());

const vm = WorkspaceId("vm-thinking");

it("pauses through the adapter and forgets the running guest", async () => {
	const machines = createFreestyleWorkspaceMachines("test");
	// A just-answered guest is remembered for the next call (recent-guest-state.ts).
	await machines.exec(vm, "true");
	await machines.pause?.(vm);
	expect(provider.state).toBe("paused");
	// Not served from the remembered running read: it sees the pause.
	await expect(machines.exec(vm, "ls")).rejects.toThrow(
		"Workspace VM is paused.",
	);
});

it("starts the paused VM before running a tool's command", async () => {
	const machines = createFreestyleWorkspaceMachines("test");
	await machines.exec(vm, "true");
	await machines.pause?.(vm);
	await machines.ensureRunning(vm);
	await machines.exec(vm, "git status");
	expect(provider.calls).toEqual([
		"exec true",
		"pause",
		"start",
		// The guest probe after a resume, then the command.
		"exec true",
		"exec git status",
	]);
});

it("resumes transparently through the turn's machines", async () => {
	const { thinkingPauseScheduler } = await import(
		"#/server/services/thinking-pause"
	);
	const machines = createFreestyleWorkspaceMachines("test");
	const timers: (() => void)[] = [];
	const scheduler = thinkingPauseScheduler({
		vm: () => vm,
		machines,
		otherTurnOnMachine: async () => false,
		backgroundCommands: async () => 0,
		attachments: async () => ({ viewers: 0, terminals: 0 }),
		timers: { set: (run) => timers.push(run), clear: () => undefined },
		log: () => undefined,
	});
	scheduler.toolStarted("a");
	scheduler.toolEnded("a");
	timers.shift()?.();
	await vi.waitFor(() => expect(provider.state).toBe("paused"));
	const turnMachines = resumingAfterThinkingPause(machines, {
		log: () => undefined,
	});
	await turnMachines.exec(vm, "npm test");
	expect(provider.calls.slice(-3)).toEqual([
		"start",
		"exec true",
		"exec npm test",
	]);
});
