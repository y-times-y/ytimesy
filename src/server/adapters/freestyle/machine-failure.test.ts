import { FreestyleApiError } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	machineBudgetSpent,
	machineFailureDetail,
	machineFailureKind,
	machineStartUnstartable,
	rateLimitDelayMs,
	resumableMachineStart,
	spentBudgetEvidence,
} from "./machine-failure";
import { isPlatformRestart } from "./provider-retry";

const api = (status: number, code: string, message: string) =>
	new FreestyleApiError(status, { code, message }, "/v5/vms");

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("classifies the provider's error shapes", () => {
	expect(
		machineFailureKind(
			api(409, "CONFLICT", "conflict: vm slug `x` is already in use"),
		),
	).toBe("conflict");
	expect(machineFailureKind(api(429, "RATE_LIMITED", "slow down"))).toBe(
		"rate-limited",
	);
	expect(machineFailureKind(api(404, "NOT_FOUND", "not found: vm x"))).toBe(
		"not-found",
	);
	expect(
		machineFailureKind(api(503, "UNAVAILABLE", "Service unavailable")),
	).toBe("transient");
	expect(
		machineFailureKind(
			new Error(
				"Another operation is updating this machine's usage. Try again shortly.",
			),
		),
	).toBe("busy");
	expect(
		machineFailureKind(api(403, "LIMIT_EXCEEDED", "at its VM limit")),
	).toBe("quota");
	expect(machineFailureKind(new Error("something new"))).toBe("permanent");
	// Wrapped as Effect and our adapters wrap it.
	expect(
		machineFailureKind(
			new Error("wrapped", {
				cause: api(409, "CONFLICT", "vm slug `x` is already in use"),
			}),
		),
	).toBe("conflict");
});

it("waits out a held lease, a taken slug and transient errors, then succeeds", async () => {
	const operation = vi
		.fn<() => Promise<string>>()
		.mockRejectedValueOnce(
			new Error(
				"Another operation is updating this machine's usage. Try again shortly.",
			),
		)
		.mockRejectedValueOnce(
			api(409, "CONFLICT", "vm slug `x` is already in use"),
		)
		.mockRejectedValueOnce(api(500, "INTERNAL", "Internal server error"))
		.mockResolvedValue("vm-1");
	const waits: number[] = [];
	await expect(
		resumableMachineStart(
			operation,
			{ operation: "test", slug: "x" },
			[1, 2, 3],
			async (ms) => {
				waits.push(ms);
			},
		),
	).resolves.toBe("vm-1");
	expect(waits).toEqual([1, 2, 3]);
	expect(console.warn).toHaveBeenCalledTimes(3);
});

it("does not repeat a permanent failure, and logs its raw cause redacted", async () => {
	const operation = vi.fn(() =>
		Promise.reject(
			new Error("odd refusal Bearer abcdefghijklmnop for vm-9", {
				cause: api(400, "BAD_REQUEST", "snapshot sh-1 is not bootable"),
			}),
		),
	);
	await expect(
		resumableMachineStart(
			operation,
			{ operation: "test", vmId: "vm-9" },
			[1],
			async () => {},
		),
	).rejects.toThrow("odd refusal");
	expect(operation).toHaveBeenCalledTimes(1);
	const [, fields] = vi.mocked(console.warn).mock.calls[0] as [
		string,
		{ detail: string; kind: string; vmId: string },
	];
	expect(fields.kind).toBe("permanent");
	expect(fields.vmId).toBe("vm-9");
	expect(fields.detail).toContain("odd refusal");
	expect(fields.detail).toContain("FreestyleApiError 400 BAD_REQUEST /v5/vms");
	expect(fields.detail).not.toContain("abcdefghijklmnop");
});

it("gives up once the backoff is spent", async () => {
	const operation = vi.fn(() =>
		Promise.reject(api(502, "BAD_GATEWAY", "Bad gateway")),
	);
	await expect(
		resumableMachineStart(
			operation,
			{ operation: "test" },
			[1, 1],
			async () => {},
		),
	).rejects.toThrow("Bad gateway");
	expect(operation).toHaveBeenCalledTimes(3);
});

it("names every link of a failure chain once", () => {
	const inner = api(409, "CONFLICT", "slug taken");
	expect(machineFailureDetail(new Error("outer", { cause: inner }))).toBe(
		"Error: outer <- FreestyleApiError 409 CONFLICT /v5/vms: slug taken",
	);
});

it("recognizes a Durable Object reset for a new version, however wrapped", () => {
	expect(
		isPlatformRestart(
			new Error("wrapped", {
				cause: new Error("Durable Object reset because its code was updated."),
			}),
		),
	).toBe(true);
	expect(isPlatformRestart(new Error("Internal server error"))).toBe(false);
	expect(
		isPlatformRestart(
			new Error(
				"Durable Object's isolate exceeded its memory limit and was reset.",
			),
		),
	).toBe(true);
	expect(
		isPlatformRestart(new Error("Command exceeded its memory limit")),
	).toBe(false);
});

it("repeats a start that never reached running once, with a fresh attempt, then surfaces it", async () => {
	const stuck = () =>
		new Error("Workspace VM did not become running", {
			cause: new Error("WorkspaceProvisionError"),
		});
	expect(machineFailureKind(stuck())).toBe("stuck");
	expect(
		machineFailureKind(
			new Error("Agent session VM stopped before it became running"),
		),
	).toBe("stuck");
	const operation = vi.fn(() => Promise.reject(stuck()));
	await expect(
		resumableMachineStart(
			operation,
			{ operation: "test", vmId: "vm-9" },
			[1, 2, 4, 8],
			async () => {},
		),
	).rejects.toThrow("did not become running");
	expect(operation).toHaveBeenCalledTimes(2);
});

it("returns the machine when the repeated start comes up", async () => {
	const operation = vi
		.fn()
		.mockRejectedValueOnce(new Error("Workspace VM did not become running"))
		.mockResolvedValue("vm-9");
	await expect(
		resumableMachineStart(
			operation,
			{ operation: "test", vmId: "vm-9" },
			[1],
			async () => {},
		),
	).resolves.toBe("vm-9");
});

it("counts only the VM's own failed starts as unstartable", () => {
	expect(
		machineStartUnstartable(new Error("Workspace VM did not become running")),
	).toBe(true);
	expect(
		machineStartUnstartable(api(504, "PROVIDER_TIMEOUT", "gateway timeout")),
	).toBe(true);
	// The VM's host is full (a 429 for this VM, not an account limit).
	expect(
		machineStartUnstartable(
			api(429, "TOO_MANY_REQUESTS", "server is at capacity; try again shortly"),
		),
	).toBe(true);
	// A VM the provider runs whose guest never answers a command.
	expect(
		machineStartUnstartable(
			new Error(
				"Workspace VM started but is not answering yet. Retrying automatically.",
			),
		),
	).toBe(true);
	// The wrapped form the adapter throws: public message, raw detail.
	expect(
		machineStartUnstartable(
			Object.assign(new Error("The workspace machine is not responding."), {
				detail: "FreestyleApiError 504 PROVIDER_TIMEOUT /v5/vms/x/start",
			}),
		),
	).toBe(true);
	for (const refused of [
		api(409, "LIMIT_EXCEEDED", "limit of 20 VMs reached"),
		new Error("Your compute allowance for vcpu_time has been used"),
		api(404, "NOT_FOUND", "not found: vm x"),
		api(401, "UNAUTHORIZED", "bad key"),
		new Error("something else"),
	])
		expect(machineStartUnstartable(refused)).toBe(false);
});

it("recognises a spent runtime budget so the chat's VM is replaced at once", () => {
	expect(
		machineBudgetSpent(
			api(409, "CONFLICT", "vm has used its total runtime budget of 900s"),
		),
	).toBe(true);
	expect(
		machineBudgetSpent(
			new Error(
				"The machine's runtime budget is used up and this deployment cannot extend it.",
			),
		),
	).toBe(true);
	expect(machineBudgetSpent(new Error("fetch failed"))).toBe(false);
});

const limit = () =>
	api(429, "LIMIT_EXCEEDED", "Account resource limit exceeded");

it("logs machine.rate_limited and reports every provider limit hit, then succeeds without surfacing an error", async () => {
	const hits: string[] = [];
	let calls = 0;
	const result = await resumableMachineStart(
		async () => {
			if (++calls < 4) throw limit();
			return "vm";
		},
		{ operation: "provisionSession", slug: "s" },
		[1, 1, 1, 1],
		async () => {},
		(hit) => hits.push(hit.operation),
	);
	expect(result).toBe("vm");
	expect(hits).toHaveLength(3);
	const lines = vi
		.mocked(console.warn)
		.mock.calls.filter((call) => call[0] === "machine.rate_limited");
	expect(lines).toHaveLength(3);
	expect(JSON.stringify(lines[0])).not.toMatch(/token|secret/i);
});

it("waits longer after a provider limit than after a 5xx, with jitter, and honours Retry-After", () => {
	const base = 8_000;
	for (const random of [0, 0.5, 0.999]) {
		const wait = rateLimitDelayMs(base, undefined, () => random);
		expect(wait).toBeGreaterThanOrEqual(base);
		expect(wait).toBeLessThanOrEqual(base * 1.5);
	}
	expect(rateLimitDelayMs(1_000, 20_000, () => 0)).toBe(20_000);
	expect(rateLimitDelayMs(1_000, 10 * 60_000, () => 0)).toBe(60_000);
});

it("names a stopped VM whose runtime cap is used up, so it is replaced at once instead of after four failed wakes (2026-11-26: vm-124b… stopped at 2628 of 2628 s, 4 'did not become running' rounds)", () => {
	const detail = spentBudgetEvidence({
		state: "stopped",
		totalRunSeconds: 2628,
		maxRunTotalSeconds: 2628,
	});
	expect(detail).toMatch(/runtime budget/);
	expect(machineBudgetSpent({ detail })).toBe(true);
	expect(
		spentBudgetEvidence({
			state: "stopped",
			totalRunSeconds: 100,
			maxRunTotalSeconds: 2628,
		}),
	).toBeUndefined();
	expect(spentBudgetEvidence({ state: "stopped" })).toBeUndefined();
});
