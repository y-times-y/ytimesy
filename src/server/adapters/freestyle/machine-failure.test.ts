import { FreestyleApiError } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	machineFailureDetail,
	machineFailureKind,
	resumableMachineStart,
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
