import { FreestyleApiError, type Vm } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import {
	GUEST_PROBE_BUDGETS_MS,
	GUEST_PROBE_RETRY_DELAYS_MS,
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
		[20_000],
	);
	await vi.advanceTimersByTimeAsync(21_000);
	await waiting;
	expect(exec).toHaveBeenCalledTimes(2);
});
it("probes a just-resumed guest again within a second, and gives later probes longer", async () => {
	vi.useFakeTimers();
	const sentAt: number[] = [];
	const exec = vi.fn().mockImplementation(() => {
		sentAt.push(Date.now());
		// The first two hang (sent before the guest was up); the third answers.
		return sentAt.length < 3
			? new Promise(() => {})
			: Promise.resolve({ statusCode: 0 });
	});
	const start = Date.now();
	const waiting = waitUntilGuestAnswers({ id: "vm-test", exec }, "Test");
	await vi.advanceTimersByTimeAsync(10_000);
	await waiting;
	expect(exec).toHaveBeenCalledTimes(3);
	// 3 s budget, 250 ms pause, 3 s budget, 500 ms pause: answered at 6.75 s,
	// where hanging probes (each bound at 10 s or more) and a 1 s first
	// pause took over 20 s.
	expect(sentAt.map((at) => at - start)).toEqual([0, 3_250, 6_750]);
	expect(GUEST_PROBE_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(250);
	expect(GUEST_PROBE_BUDGETS_MS.at(-1)).toBe(20_000);
});
it("says plainly that a guest never answered, and rethrows other failures at once", async () => {
	const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
	await expect(
		waitUntilGuestAnswers({ id: "vm-test", exec: failing }, "Test VM", [0, 0]),
	).rejects.toThrow(
		"Test VM started but is not answering yet. Retrying automatically.",
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

it("gives a slow guest an extended readiness window, still probing quickly first", () => {
	const sleeping = GUEST_PROBE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
	expect(sleeping).toBeGreaterThanOrEqual(60_000);
	expect(GUEST_PROBE_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(250);
	expect(GUEST_PROBE_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(9);
});

const notFound = () =>
	new FreestyleApiError(
		404,
		{ code: "NOT_FOUND", message: "not found: vm vm-test" },
		"/v5/vms/vm-test",
	);
it("waits out a 404 on a VM that was only just created (provider lag), then sees it running", async () => {
	vi.useFakeTimers();
	const data = vi
		.fn()
		.mockRejectedValueOnce(notFound())
		.mockRejectedValueOnce(notFound())
		.mockResolvedValue({ state: "running" });
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
	);
	await vi.runAllTimersAsync();
	await expect(waiting).resolves.toMatchObject({ state: "running" });
	expect(data).toHaveBeenCalledTimes(3);
});
it("still reports a VM that stays missing after the grace", async () => {
	vi.useFakeTimers();
	const data = vi.fn().mockRejectedValue(notFound());
	const waiting = waitUntilVmRunning(
		{ id: "vm-test", data } as unknown as Vm,
		"Test",
	);
	const assertion = expect(waiting).rejects.toBeDefined();
	await vi.runAllTimersAsync();
	await assertion;
	expect(data.mock.calls.length).toBeGreaterThan(3);
});

it("readVmData retries a 404 a few times and gives a still-missing VM back as its 404", async () => {
	const { readVmData } = await import("./wait-until-running");
	const flaky = vi
		.fn()
		.mockRejectedValueOnce(notFound())
		.mockResolvedValue({ state: "paused" });
	await expect(readVmData(flaky, [0, 0])).resolves.toEqual({ state: "paused" });
	const gone = vi.fn().mockRejectedValue(notFound());
	await expect(readVmData(gone, [0, 0])).rejects.toMatchObject({ status: 404 });
	expect(gone).toHaveBeenCalledTimes(3);
	const other = vi.fn().mockRejectedValue(new Error("boom"));
	await expect(readVmData(other, [0, 0])).rejects.toThrow("boom");
	expect(other).toHaveBeenCalledTimes(1);
});
