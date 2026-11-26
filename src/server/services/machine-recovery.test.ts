import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	STALL_PROBE_AFTER_MS,
	totalProbeWaitMs,
} from "#/domain/machine-health";
import { recoveringMachines, waitForMachine } from "./machine-recovery";
import type { WorkspaceMachines } from "./workspace-machines";

const vm = WorkspaceId("vm-1");

/** A fake machine whose answers are scripted by a virtual clock. */
function fixture(script: {
	down: (t: number) => boolean;
	hang?: (t: number) => boolean;
}) {
	let t = 0;
	const states: string[] = [];
	const exec = vi.fn(async (_vm: unknown, command: string) => {
		if (script.hang?.(t) && command !== "true")
			return new Promise<never>(() => {});
		if (script.down(t)) throw new Error("Internal server error");
		return { exitCode: 0, stdout: "ok", stderr: "" };
	});
	const machines = {
		exec,
		ensureRunning: vi.fn(async (id: WorkspaceId) => id),
		readTextFile: vi.fn(async () => {
			if (script.down(t)) throw new Error("Internal server error");
			return "file";
		}),
		writeTextFile: vi.fn(async () => undefined),
	} as unknown as WorkspaceMachines;
	const sleep = vi.fn(async (ms: number) => {
		t += ms;
		// Yield like a real timer would, so a looping watcher cannot starve the test.
		await new Promise((resolve) => setImmediate(resolve));
	});
	return {
		machines,
		exec,
		sleep,
		states,
		now: () => t,
		options: {
			sleep,
			// The long-call watcher stays quiet unless a test drives it.
			watchSleep: () => new Promise<void>(() => {}),
			now: () => t,
			onState: (state: string) => void states.push(state),
		},
	};
}

describe("machine recovery (fault injection)", () => {
	it("a machine overloaded for a minute: the call fails once, the person sees Recovering, the machine answers, the model retries", async () => {
		const f = fixture({ down: (t) => t < 60_000 });
		const machines = recoveringMachines(f.machines, f.options);
		await expect(machines.exec(vm, "tsc")).rejects.toThrow(
			"Internal server error",
		);
		expect(f.states).toEqual(["recovering", "recovered"]);
		await expect(machines.exec(vm, "git status")).resolves.toMatchObject({
			exitCode: 0,
		});
	});
	it("a read is simply run again once the machine answers", async () => {
		const f = fixture({ down: (t) => t < 20_000 });
		const machines = recoveringMachines(f.machines, f.options);
		await expect(machines.readTextFile(vm, "/a")).resolves.toBe("file");
		expect(f.states).toEqual(["recovering", "recovered"]);
	});
	it("a machine silent for the whole window fails the step as MachineNotResponding, for its executor to resume", async () => {
		const f = fixture({ down: () => true });
		const machines = recoveringMachines(f.machines, f.options);
		await expect(machines.exec(vm, "tsc")).rejects.toMatchObject({
			name: "MachineNotResponding",
		});
		expect(f.states).toEqual(["recovering", "failed"]);
		expect(f.sleep.mock.calls.reduce((sum, call) => sum + call[0], 0)).toBe(
			totalProbeWaitMs(),
		);
	});
	it("a tool call that never returns while the machine stops answering is recovered after about 3-5 minutes", async () => {
		const f = fixture({
			down: (t) => t >= 1_000 && t < 400_000,
			hang: (t) => t < 1_000,
		});
		const machines = recoveringMachines(f.machines, {
			...f.options,
			watchSleep: f.sleep,
		});
		const call = machines.exec(vm, "long").then(
			() => "returned",
			(error: Error) => error.message,
		);
		await vi.waitFor(() => expect(f.sleep).toHaveBeenCalled());
		// Drive the virtual clock until the stall watcher and the recovery have run.
		for (let i = 0; i < 200 && f.states.length < 2; i++) {
			await Promise.resolve();
			await new Promise((resolve) => setImmediate(resolve));
		}
		const message = await call;
		expect(message).toContain("stopped answering");
		expect(f.states[0]).toBe("recovering");
		expect(f.now()).toBeGreaterThanOrEqual(STALL_PROBE_AFTER_MS);
		expect(f.now()).toBeLessThan(10 * 60_000);
	});
	it("a long command on a healthy machine is never interrupted", async () => {
		const f = fixture({ down: () => false });
		const machines = recoveringMachines(f.machines, {
			...f.options,
			watchSleep: f.sleep,
		});
		let finish!: () => void;
		f.exec.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ exitCode: 0, stdout: "done", stderr: "" });
				}),
		);
		const call = machines.exec(vm, "npm test");
		for (let i = 0; i < 30; i++)
			await new Promise((resolve) => setImmediate(resolve));
		finish();
		await expect(call).resolves.toMatchObject({ stdout: "done" });
		expect(f.states).toEqual([]);
	});
	it("a command's own failure and the person's Stop are not machine trouble", async () => {
		const f = fixture({ down: () => false });
		f.exec.mockRejectedValueOnce(new Error("exit 2: tests failed"));
		const machines = recoveringMachines(f.machines, f.options);
		await expect(machines.exec(vm, "npm test")).rejects.toThrow("tests failed");
		expect(f.states).toEqual([]);
		const stopped = new AbortController();
		stopped.abort();
		f.exec.mockRejectedValueOnce(new Error("Internal server error"));
		const stoppedMachines = recoveringMachines(f.machines, {
			...f.options,
			signal: stopped.signal,
		});
		await expect(stoppedMachines.exec(vm, "x")).rejects.toThrow(
			"Internal server error",
		);
		expect(f.states).toEqual([]);
	});
	it("two calls failing together share one recovery", async () => {
		const f = fixture({ down: (t) => t < 10_000 });
		const machines = recoveringMachines(f.machines, f.options);
		await Promise.allSettled([machines.exec(vm, "a"), machines.exec(vm, "b")]);
		expect(f.states.filter((state) => state === "recovering")).toHaveLength(1);
	});
	it("waitForMachine answers true once the machine does", async () => {
		const f = fixture({ down: (t) => t < 8_000 });
		expect(await waitForMachine(f.machines, vm, f.options)).toBe(true);
	});
});
