import { FreestyleApiError, type Vm } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import {
	waitUntilGuestAnswers,
	waitUntilVmRunning,
} from "./wait-until-running";

afterEach(() => vi.useRealTimers());
it("returns immediately for a running VM", async () => {
	const data = vi.fn().mockResolvedValue({ state: "running" });
	await expect(
		waitUntilVmRunning({ id: "vm-test", data } as unknown as Vm, "Test"),
	).resolves.toMatchObject({ state: "running" });
	expect(data).toHaveBeenCalledTimes(1);
});
it("starts a stopped VM once, then gives up if it stays stopped", async () => {
	vi.useFakeTimers();
	const start = vi.fn().mockResolvedValue(undefined);
	const data = vi.fn().mockResolvedValue({ state: "stopped" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data, start } as unknown as Vm,
		"Test",
	);
	const assertion = expect(waiting).rejects.toThrow("stopped before");
	await vi.runAllTimersAsync();
	await assertion;
	expect(start).toHaveBeenCalledTimes(1);
});
it("recovers a VM that reads stopped and then starts", async () => {
	vi.useFakeTimers();
	const start = vi.fn().mockResolvedValue(undefined);
	const data = vi
		.fn()
		.mockResolvedValueOnce({ state: "stopped" })
		.mockResolvedValueOnce({ state: "starting" })
		.mockResolvedValue({ state: "running" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data, start } as unknown as Vm,
		"Test",
	);
	await vi.runAllTimersAsync();
	await expect(waiting).resolves.toMatchObject({ state: "running" });
});
it("gives up on a VM stuck starting after 60 seconds, asking for the start again twice", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	const start = vi.fn().mockResolvedValue(undefined);
	const data = vi.fn().mockResolvedValue({ state: "starting" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data, start } as unknown as Vm,
		"Test",
	);
	const assertion = expect(waiting).rejects.toThrow("did not become running");
	await vi.runAllTimersAsync();
	await assertion;
	const waited = Date.now() - started;
	expect(waited).toBeGreaterThan(59_000);
	expect(waited).toBeLessThanOrEqual(60_000);
	expect(start).toHaveBeenCalledTimes(2);
});
it("keeps waiting up to three minutes for a machine that is pausing", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	const data = vi.fn().mockResolvedValue({ state: "pausing" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
	);
	const assertion = expect(waiting).rejects.toThrow("did not become running");
	await vi.runAllTimersAsync();
	await assertion;
	expect(Date.now() - started).toBeGreaterThan(179_000);
});
it("reads a just-started machine again within a fraction of a second", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	const data = vi
		.fn()
		.mockResolvedValueOnce({ state: "starting" })
		.mockResolvedValueOnce({ state: "starting" })
		.mockResolvedValue({ state: "running" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
	);
	await vi.runAllTimersAsync();
	await expect(waiting).resolves.toMatchObject({ state: "running" });
	// 200 ms, then 300 ms: running at 0.5 s instead of 2 s.
	expect(Date.now() - started).toBe(500);
});
it("starts a machine that finished pausing while the caller waited", async () => {
	vi.useFakeTimers();
	const start = vi.fn().mockResolvedValue(undefined);
	const data = vi
		.fn()
		.mockResolvedValueOnce({ state: "pausing" })
		.mockResolvedValueOnce({ state: "paused" })
		.mockResolvedValueOnce({ state: "starting" })
		.mockResolvedValue({ state: "running" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data, start } as unknown as Vm,
		"Test",
	);
	await vi.runAllTimersAsync();
	await expect(waiting).resolves.toMatchObject({ state: "running" });
	expect(start).toHaveBeenCalledTimes(1);
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

it("retries a just-started guest's probe until it answers", async () => {
	const exec = vi
		.fn()
		.mockRejectedValueOnce(new TypeError("fetch failed"))
		.mockRejectedValueOnce(
			new FreestyleApiError(
				504,
				{ code: "UNKNOWN_ERROR", message: "Request Timeout" },
				"/v5/background-requests/req-1",
			),
		)
		.mockResolvedValue({ statusCode: 0 });
	await waitUntilGuestAnswers({ id: "vm-test", exec }, "Test", [0, 0, 0]);
	expect(exec).toHaveBeenCalledTimes(3);
	expect(exec).toHaveBeenCalledWith({ command: "true", timeoutMs: 10_000 });
});
it("abandons a probe that hangs and tries again", async () => {
	vi.useFakeTimers();
	const exec = vi
		.fn()
		.mockReturnValueOnce(new Promise(() => {}))
		.mockResolvedValue({ statusCode: 0 });
	const waiting = waitUntilGuestAnswers(
		{ id: "vm-test", exec },
		"Test",
		[1_000],
		20_000,
	);
	await vi.advanceTimersByTimeAsync(21_000);
	await waiting;
	expect(exec).toHaveBeenCalledTimes(2);
});
it("says plainly that a guest never answered, and rethrows other failures at once", async () => {
	const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
	await expect(
		waitUntilGuestAnswers({ id: "vm-test", exec: failing }, "Test VM", [0, 0]),
	).rejects.toThrow(
		"Test VM started but is not answering yet. Try again in a minute.",
	);
	expect(failing).toHaveBeenCalledTimes(3);
	const conflict = new FreestyleApiError(
		409,
		{ code: "CONFLICT", message: "used its total runtime budget" },
		"/v5/vms/x/exec-await",
	);
	const refused = vi.fn().mockRejectedValue(conflict);
	await expect(
		waitUntilGuestAnswers({ id: "vm-test", exec: refused }, "Test", [0, 0]),
	).rejects.toBe(conflict);
	expect(refused).toHaveBeenCalledTimes(1);
});
