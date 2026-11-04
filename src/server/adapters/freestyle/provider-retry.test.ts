import { FreestyleApiError } from "freestyle";
import { expect, it, vi } from "vitest";
import {
	isTransientProviderFailure,
	isWorkersRuntimeBlip,
	retryTransientProviderFailure,
} from "./provider-retry";

it("recognizes the Workers runtime's answers while a deploy swaps versions", () => {
	for (const message of [
		"internal error; reference = 9a1fq3l2k0mrp8s4bd7c",
		"Network connection lost.",
		"The Durable Object's code has been updated, this version can no longer access storage.",
		"Durable Object reset because its code was updated.",
		"Cannot resolve Durable Object due to transient issue on remote node.",
	])
		expect(isWorkersRuntimeBlip(new Error(message))).toBe(true);
	expect(
		isWorkersRuntimeBlip(
			new Error("step failed", {
				cause: new Error("internal error; reference = abc"),
			}),
		),
	).toBe(true);
	expect(isWorkersRuntimeBlip(new Error("relation does not exist"))).toBe(
		false,
	);
	expect(isWorkersRuntimeBlip(internal())).toBe(false);
	// Collected failures are a blip only when every one is.
	expect(
		isWorkersRuntimeBlip(
			new AggregateError([
				new Error("Network connection lost."),
				new Error("internal error; reference = abc"),
			]),
		),
	).toBe(true);
	expect(
		isWorkersRuntimeBlip(
			new AggregateError([
				new Error("Network connection lost."),
				new Error("permission denied for table"),
			]),
		),
	).toBe(false);
});

const internal = () =>
	new FreestyleApiError(
		500,
		{ code: "INTERNAL", message: "Internal server error" },
		"/v1/vms",
	);

it("retries a provider internal server error and then succeeds", async () => {
	const operation = vi
		.fn<() => Promise<string>>()
		.mockRejectedValueOnce(internal())
		.mockRejectedValueOnce(new Error("wrapped", { cause: internal() }))
		.mockResolvedValue("vm-1");
	await expect(retryTransientProviderFailure(operation, [0, 0])).resolves.toBe(
		"vm-1",
	);
	expect(operation).toHaveBeenCalledTimes(3);
});

it("gives up after its backoff and surfaces the last error", async () => {
	const operation = vi.fn(() => Promise.reject(internal()));
	await expect(retryTransientProviderFailure(operation, [0])).rejects.toThrow(
		"Internal server error",
	);
	expect(operation).toHaveBeenCalledTimes(2);
});

it("never retries a conflict or a budget refusal", async () => {
	const conflict = new FreestyleApiError(
		409,
		{ code: "CONFLICT", message: "used its total runtime budget" },
		"/v1/vms/x/start",
	);
	expect(isTransientProviderFailure(conflict)).toBe(false);
	const operation = vi.fn(() => Promise.reject(conflict));
	await expect(retryTransientProviderFailure(operation, [0, 0])).rejects.toBe(
		conflict,
	);
	expect(operation).toHaveBeenCalledTimes(1);
});

it("treats a fresh guest's fetch failure and the provider's request timeout as transient", () => {
	expect(isTransientProviderFailure(new TypeError("fetch failed"))).toBe(true);
	expect(
		isTransientProviderFailure(
			new FreestyleApiError(
				504,
				{ code: "UNKNOWN_ERROR", message: "Request Timeout" },
				"/v5/background-requests/req-1",
			),
		),
	).toBe(true);
	expect(
		isTransientProviderFailure(
			new FreestyleApiError(
				408,
				{ code: "UNKNOWN_ERROR", message: "Request Timeout" },
				"/v5/vms/x/exec-await",
			),
		),
	).toBe(true);
	// A caller's abort or a not-found answer is final.
	expect(
		isTransientProviderFailure(new DOMException("aborted", "AbortError")),
	).toBe(false);
	expect(
		isTransientProviderFailure(
			new FreestyleApiError(
				404,
				{ code: "UNKNOWN_ERROR", message: "Not Found" },
				"/v5/vms/x",
			),
		),
	).toBe(false);
});
