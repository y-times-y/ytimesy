import { Freestyle } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { environmentFreestyleFetch } from "../src/server/adapters/freestyle/environment-fetch";

afterEach(() => vi.useRealTimers());

it("extends the inline window without disabling SDK background recovery or replaying a mutation", async () => {
	vi.useFakeTimers();
	const counts = { requests: 0, backgroundPolls: 0 };
	const transport = vi.fn<typeof fetch>(async (_input, init) => {
		if (init?.method === "POST") {
			expect(
				new Headers(init.headers).get("x-freestyle-background-after-secs"),
			).toBe("30");
			return Response.json({ requestId: "fixture" }, { status: 202 });
		}
		return Response.json({ state: "paused" });
	});
	const sdk = new Freestyle({
		apiKey: "fixture",
		fetch: environmentFreestyleFetch(counts, transport),
	});
	const result = sdk.vms.ref("fixture").pause();
	await vi.advanceTimersByTimeAsync(2000);
	expect(await result).toEqual({ state: "paused" });
	expect(counts).toEqual({ requests: 2, backgroundPolls: 1 });
	expect(
		transport.mock.calls.filter(([, init]) => init?.method === "POST"),
	).toHaveLength(1);
});

it("does not introduce background mode, modify other origins, or lose cancellation", async () => {
	const counts = { requests: 0, backgroundPolls: 0 };
	const controller = new AbortController();
	const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
	const fetch = environmentFreestyleFetch(counts, transport);
	await fetch("https://api.freestyle.sh/v5/vms", { signal: controller.signal });
	expect(
		new Headers(transport.mock.calls[0][1]?.headers).has(
			"x-freestyle-background-after-secs",
		),
	).toBe(false);
	expect(transport.mock.calls[0][1]?.signal).toBe(controller.signal);
	await fetch("https://other.invalid/v5/vms", {
		headers: { "x-freestyle-background-after-secs": "5" },
	});
	expect(
		new Headers(transport.mock.calls[1][1]?.headers).get(
			"x-freestyle-background-after-secs",
		),
	).toBe("5");
	expect(counts).toEqual({ requests: 1, backgroundPolls: 0 });
});
