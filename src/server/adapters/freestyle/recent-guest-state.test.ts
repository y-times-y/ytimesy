import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

const provider = vi.hoisted(() => ({
	state: "running",
	reads: 0,
	exec: vi.fn(),
}));
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const vm = (id: string) => ({
		id,
		data: async () => {
			provider.reads++;
			return { id, state: provider.state, idleTimeoutSeconds: 180 };
		},
		exec: provider.exec,
		fs: { writeTextFile: async () => {} },
		delete: async () => {},
	});
	return {
		...actual,
		Freestyle: class {
			vms = { ref: vm };
		},
	};
});
beforeEach(() => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.state = "running";
	provider.reads = 0;
	provider.exec.mockReset().mockResolvedValue({ statusCode: 0 });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

it("reads a running VM once for back-to-back guest operations, then again after the window", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const machines = createFreestyleWorkspaceMachines("test");
	const vm = "vm-a" as Parameters<typeof machines.exec>[0];
	await machines.exec(vm, "true");
	await machines.writeTextFile(vm, "/tmp/x", "x");
	await machines.exec(vm, "true");
	expect(provider.reads).toBe(1);
	vi.advanceTimersByTime(10_001);
	await machines.exec(vm, "true");
	expect(provider.reads).toBe(2);
});

it("reads again after a failed operation, a destroy, and never trusts a paused VM", async () => {
	const machines = createFreestyleWorkspaceMachines("test");
	const vm = "vm-b" as Parameters<typeof machines.exec>[0];
	await machines.exec(vm, "true");
	provider.exec.mockRejectedValueOnce(new Error("guest gone"));
	await expect(machines.exec(vm, "true")).rejects.toThrow();
	expect(provider.reads).toBe(1);
	await machines.exec(vm, "true");
	expect(provider.reads).toBe(2);
	await machines.destroy(vm);
	provider.state = "paused";
	await expect(machines.exec(vm, "true")).rejects.toThrow();
	await expect(machines.exec(vm, "true")).rejects.toThrow();
	expect(provider.reads).toBe(4);
});
