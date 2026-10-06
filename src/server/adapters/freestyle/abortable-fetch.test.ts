import { Freestyle } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { abortableFreestyleFetch } from "./abortable-fetch";

afterEach(() => vi.useRealTimers());

it("terminates SDK background polling after the operation deadline", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const transport = vi.fn<typeof fetch>(async (_url, init) => {
		init?.signal?.throwIfAborted();
		return new Response(JSON.stringify({ requestId: "test-request" }), {
			status: 202,
		});
	});
	const sdk = new Freestyle({
		apiKey: "fixture-only",
		fetch: abortableFreestyleFetch(controller.signal, transport),
	});
	const result = expect(sdk.vms.list()).rejects.toThrow("Evaluation ended");
	await vi.advanceTimersByTimeAsync(2000);
	controller.abort(new Error("Evaluation ended"));
	await vi.advanceTimersByTimeAsync(12000);
	await result;
	// Cancellation must not issue another provider request or replay the initial call.
	expect(transport).toHaveBeenCalledTimes(2);
});

it("preserves request cancellation as well as the shared operation deadline", async () => {
	const operation = new AbortController();
	const request = new AbortController();
	const transport = vi.fn<typeof fetch>(async (_url, init) => {
		init?.signal?.throwIfAborted();
		return new Response("ok");
	});
	request.abort(new Error("Request cancelled"));
	await expect(
		abortableFreestyleFetch(operation.signal, transport)(
			"https://example.test",
			{
				signal: request.signal,
			},
		),
	).rejects.toThrow("Request cancelled");
	expect(transport).not.toHaveBeenCalled();
});
