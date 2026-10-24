import { Freestyle, FreestyleApiError } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import {
	boundedFreestyleFetch,
	PROVIDER_OPERATION_MS,
	PROVIDER_TIMEOUT_CODE,
	providerOperationBudgetMs,
} from "./bounded-fetch";
import { isTransientProviderFailure } from "./provider-retry";

afterEach(() => vi.useRealTimers());

const accepted = () =>
	new Response(JSON.stringify({ requestId: "req-1" }), {
		status: 202,
		headers: { "x-freestyle-background-request-id": "req-1" },
	});

it("stops polling a backgrounded exec at its own timeout plus a grace, instead of ~12 minutes", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	// The provider never finishes: every poll answers 202 again.
	const transport = vi.fn<typeof fetch>(async () => accepted());
	const sdk = new Freestyle({
		apiKey: "fixture-only",
		fetch: boundedFreestyleFetch(transport),
	});
	let failedAt = 0;
	const exec = sdk.vms
		.ref("vm-new")
		.exec({ command: "true", timeoutMs: 10_000 })
		.catch((error: unknown) => {
			failedAt = Date.now();
			return error;
		});
	await vi.advanceTimersByTimeAsync(600_000);
	const error = await exec;
	expect(error).toMatchObject({ status: 504, code: PROVIDER_TIMEOUT_CODE });
	expect(isTransientProviderFailure(error)).toBe(true);
	// 10 s exec timeout + 90 s grace, to the next 2 s poll.
	expect(failedAt - started).toBeGreaterThanOrEqual(100_000);
	expect(failedAt - started).toBeLessThanOrEqual(104_000);
});

it("gives up on a request whose connection stalls", async () => {
	vi.useFakeTimers();
	const transport = vi.fn<typeof fetch>(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			}),
	);
	const sdk = new Freestyle({
		apiKey: "fixture-only",
		fetch: boundedFreestyleFetch(transport),
	});
	const read = sdk.vms.ref("vm-new").data();
	const assertion = expect(read).rejects.toBeInstanceOf(FreestyleApiError);
	// Background window (5 s) plus a minute.
	await vi.advanceTimersByTimeAsync(64_000);
	expect(transport).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(2_000);
	await assertion;
});

it("returns an answer that arrives in time unchanged, and keeps a caller's abort", async () => {
	const ok = vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify({ id: "vm-1", state: "running" })),
	);
	const sdk = new Freestyle({
		apiKey: "fixture-only",
		fetch: boundedFreestyleFetch(ok),
	});
	await expect(sdk.vms.ref("vm-1").data()).resolves.toMatchObject({
		state: "running",
	});

	const caller = new AbortController();
	caller.abort(new Error("Evaluation ended"));
	const aborting = vi.fn<typeof fetch>(async (_input, init) => {
		init?.signal?.throwIfAborted();
		return new Response("ok");
	});
	await expect(
		boundedFreestyleFetch(aborting)("https://api.freestyle.sh/v5/vms", {
			signal: caller.signal,
		}),
	).rejects.toThrow("Evaluation ended");
});

it("budgets each kind of call", () => {
	const exec = (body: object) =>
		providerOperationBudgetMs(
			"POST",
			"/v5/vms/vm-1/exec-await",
			JSON.stringify(body),
		);
	expect(exec({ command: "x", timeoutMs: 30_000 })).toBe(120_000);
	expect(exec({ command: "x" })).toBe(390_000);
	expect(providerOperationBudgetMs("POST", "/v5/vms", "{}")).toBe(600_000);
	expect(providerOperationBudgetMs("POST", "/v5/vms/vm-1/snapshot", "{}")).toBe(
		600_000,
	);
	expect(providerOperationBudgetMs("POST", "/v5/vms/vm-1/start", "{}")).toBe(
		PROVIDER_OPERATION_MS,
	);
	expect(providerOperationBudgetMs("GET", "/v5/vms/vm-1", undefined)).toBe(
		PROVIDER_OPERATION_MS,
	);
});
