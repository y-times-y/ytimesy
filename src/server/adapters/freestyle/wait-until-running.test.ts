import type { Vm } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { waitUntilVmRunning } from "./wait-until-running";

afterEach(() => vi.useRealTimers());
it("returns immediately for a running VM", async () => {
	const data = vi.fn().mockResolvedValue({ state: "running" });
	await expect(
		waitUntilVmRunning({ id: "vm-test", data } as unknown as Vm, "Test"),
	).resolves.toMatchObject({ state: "running" });
	expect(data).toHaveBeenCalledTimes(1);
});
it("does not retry a stopped VM", async () => {
	const data = vi.fn().mockResolvedValue({ state: "stopped" });
	await expect(
		waitUntilVmRunning({ id: "vm-test", data } as unknown as Vm, "Test"),
	).rejects.toThrow("stopped before");
	expect(data).toHaveBeenCalledTimes(1);
});
it("bounds polling to thirty reads without retrying a create operation", async () => {
	vi.useFakeTimers();
	const data = vi.fn().mockResolvedValue({ state: "starting" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
	);
	const assertion = expect(waiting).rejects.toThrow("did not become running");
	await vi.runAllTimersAsync();
	await assertion;
	expect(data).toHaveBeenCalledTimes(30);
});
it("stops polling when its caller cancels", async () => {
	const controller = new AbortController();
	const data = vi.fn().mockResolvedValue({ state: "starting" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
		controller.signal,
	);
	controller.abort();
	await expect(waiting).rejects.toThrow();
	const count = data.mock.calls.length;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(data).toHaveBeenCalledTimes(count);
});
