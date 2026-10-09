import { expect, it, vi } from "vitest";
import { modelEndpointTransport } from "../src/server/adapters/model-endpoint";
import {
	edgeModelEndpointTransport,
	withEdgeModelEndpoints,
} from "../src/server/edge/model-endpoint";

it("streams the original response and preserves request body, credentials and cancellation", async () => {
	const abort = new AbortController();
	const response = new Response("data: fixture\n\n");
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
	const transport = edgeModelEndpointTransport(
		"https://openrouter.ai/api/v1",
		fetch,
	);
	const result = await transport.fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			body: "fixture",
			headers: { Authorization: "Bearer fixture" },
			signal: abort.signal,
		},
	);
	expect(result).toBe(response);
	const [request, options] = fetch.mock.calls[0];
	expect(request).toBeInstanceOf(Request);
	const sent = request as Request;
	expect(sent.method).toBe("POST");
	expect(sent.headers.get("authorization")).toBe("Bearer fixture");
	expect(await sent.text()).toBe("fixture");
	expect(options?.redirect).toBe("manual");
	abort.abort();
	expect(options?.signal?.aborted).toBe(true);
	await transport.close();
});

it("rejects redirects without following them or forwarding credentials", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
		new Response(null, {
			status: 302,
			headers: { location: "https://other.example" },
		}),
	);
	const transport = edgeModelEndpointTransport(
		"https://api.openai.com/v1",
		fetch,
	);
	await expect(
		transport.fetch("https://api.openai.com/v1/responses", {
			headers: { authorization: "Bearer fixture" },
		}),
	).rejects.toThrow("redirect refused");
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("normalizes Node-only redirect mode before constructing the edge Request", async () => {
	const NativeRequest = globalThis.Request;
	vi.stubGlobal(
		"Request",
		class extends NativeRequest {
			constructor(input: RequestInfo | URL, init?: RequestInit) {
				if (init?.redirect === "error")
					throw new TypeError("Unsupported edge redirect mode");
				super(input, init);
			}
		},
	);
	try {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response("fixture"));
		const transport = edgeModelEndpointTransport(
			"https://openrouter.ai/api/v1",
			fetch,
		);
		await expect(
			transport.fetch("https://openrouter.ai/api/v1/models", {
				redirect: "error",
			}),
		).resolves.toBeInstanceOf(Response);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("rejects custom endpoints, IP literals and insecure connections before any I/O", () => {
	for (const base of [
		"https://gateway.example/v1",
		"https://127.0.0.1/v1",
		"https://169.254.169.254/v1",
		"http://api.openai.com/v1",
		"https://openrouter.ai.evil.example/api/v1",
	])
		expect(() => edgeModelEndpointTransport(base)).toThrow();
});

it("rejects origin and API-path drift without transmitting credentials", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	const transport = edgeModelEndpointTransport(
		"https://api.openai.com/v1",
		fetch,
	);
	for (const url of [
		"https://other.example/v1/responses",
		"https://api.openai.com/other",
		"https://api.openai.com/v10/responses",
		"https://credential@api.openai.com/v1/responses",
	])
		await expect(transport.fetch(url)).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

it("selects the native factory only within the edge invocation", async () => {
	await withEdgeModelEndpoints(async () => {
		await Promise.resolve();
		expect(() => modelEndpointTransport("https://gateway.example/v1")).toThrow(
			"Custom model endpoints",
		);
		await modelEndpointTransport("https://api.openai.com/v1").close();
	});
	const nodeTransport = modelEndpointTransport("https://gateway.example/v1");
	await nodeTransport.close();
});
