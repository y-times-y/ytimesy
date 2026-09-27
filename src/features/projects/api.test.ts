import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { HttpRequestError, requestJson, retryTransientRead } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("recovers a project read after a transient server failure", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "Temporary failure" }), {
				status: 502,
			}),
		)
		.mockResolvedValueOnce(Response.json([{ id: "project" }]));
	vi.stubGlobal("fetch", fetch);
	const client = new QueryClient();
	try {
		const data = await client.fetchQuery({
			queryKey: ["projects"],
			queryFn: () => requestJson("/api/projects"),
			retry: retryTransientRead,
			retryDelay: 0,
		});
		expect(data).toEqual([{ id: "project" }]);
		expect(fetch).toHaveBeenCalledTimes(2);
	} finally {
		client.clear();
	}
});

it("bounds retries and does not retry authorization failures", () => {
	expect(retryTransientRead(0, new HttpRequestError("Unauthorized", 401))).toBe(
		false,
	);
	expect(retryTransientRead(0, new HttpRequestError("Forbidden", 403))).toBe(
		false,
	);
	expect(retryTransientRead(2, new HttpRequestError("Unavailable", 503))).toBe(
		false,
	);
	expect(retryTransientRead(0, new TypeError("Failed to fetch"))).toBe(true);
});

it("retains previously loaded projects when a refresh fails", async () => {
	const client = new QueryClient();
	client.setQueryData(["projects"], [{ id: "project" }]);
	try {
		await expect(
			client.fetchQuery({
				queryKey: ["projects"],
				queryFn: () => Promise.reject(new HttpRequestError("Unavailable", 503)),
				retry: retryTransientRead,
				retryDelay: 0,
			}),
		).rejects.toThrow("Unavailable");
		expect(client.getQueryData(["projects"])).toEqual([{ id: "project" }]);
	} finally {
		client.clear();
	}
});
