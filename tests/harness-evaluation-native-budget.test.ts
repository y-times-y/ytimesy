import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
	type NativeBudgetConfiguration,
	nativeBudgetProxy,
} from "../benchmarks/evaluation/native-budget-proxy";

const configuration: NativeBudgetConfiguration = {
	accessToken: "fixture-access",
	accountId: "fixture-account",
	proofToken: "p".repeat(32),
	modelId: "fixture-model",
	reasoning: "medium",
	durationSeconds: 60,
	modelRequests: 2,
	tokens: 1000,
};
const servers: ReturnType<typeof nativeBudgetProxy>["server"][] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
it("serializes overlapping requests and rejects expired attempts", async () => {
	let release: ((response: Response) => void) | undefined;
	const transport = vi.fn<typeof fetch>().mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	const proxy = await start(transport);
	const first = request(proxy.url);
	await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
	expect((await request(proxy.url)).status).toBe(429);
	release?.(stream());
	await (await first).text();
	vi.spyOn(Date, "now").mockReturnValue(proxy.snapshot().deadline + 1);
	expect((await request(proxy.url)).status).toBe(429);
	expect(transport).toHaveBeenCalledTimes(1);
});
it("stops after upstream errors or malformed completed usage", async () => {
	for (const reply of [
		new Response("provider failure", { status: 500 }),
		new Response(
			'data: {"type":"response.completed","response":{"id":"r","usage":{}}}\n\n',
		),
	]) {
		const transport = vi.fn<typeof fetch>().mockResolvedValue(reply);
		const proxy = await start(transport);
		try {
			await (await request(proxy.url)).text();
		} catch {
			/* A malformed stream is intentionally disconnected. */
		}
		expect((await request(proxy.url)).status).toBe(429);
		expect(proxy.snapshot().stopped).toBe(true);
		expect(transport).toHaveBeenCalledTimes(1);
	}
});
async function start(
	transport: typeof fetch,
	changes: Partial<NativeBudgetConfiguration> = {},
) {
	const proxy = nativeBudgetProxy(
		{ ...configuration, ...changes },
		{ transport },
	);
	servers.push(proxy.server);
	proxy.server.listen(0, "127.0.0.1");
	await once(proxy.server, "listening");
	const address = proxy.server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	return { ...proxy, url: `http://127.0.0.1:${address.port}/v1/responses` };
}
function request(
	url: string,
	changes: Record<string, unknown> = {},
	token = configuration.proofToken,
) {
	return fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: configuration.modelId,
			reasoning: { effort: "medium" },
			stream: true,
			...changes,
		}),
	});
}
function stream(tokens = 100) {
	const event = `data: ${JSON.stringify({ type: "response.completed", response: { id: "response-1", usage: { input_tokens: tokens, output_tokens: 10 } } })}\r\n\r\n`;
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of [
					event.slice(0, 13),
					event.slice(13, 39),
					event.slice(39),
				])
					controller.enqueue(new TextEncoder().encode(part));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
it("counts split SSE usage and prevents a request beyond the limit", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => stream());
	const proxy = await start(transport, { modelRequests: 1 });
	expect(await (await request(proxy.url)).text()).toContain(
		"response.completed",
	);
	expect((await request(proxy.url)).status).toBe(429);
	expect(transport).toHaveBeenCalledTimes(1);
	expect(proxy.snapshot()).toMatchObject({
		requests: 1,
		observedTokens: 110,
		stopped: false,
	});
	expect(transport.mock.calls[0][0]).toBe(
		"https://chatgpt.com/backend-api/codex/responses",
	);
});
it("ends at response.completed without waiting for upstream EOF", async () => {
	let cancelled = false;
	const completed = await stream().text();
	const transport = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(completed));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const proxy = await start(transport);
	const response = await fetch(proxy.url, {
		method: "POST",
		signal: AbortSignal.timeout(500),
		headers: { authorization: `Bearer ${configuration.proofToken}` },
		body: JSON.stringify({
			model: configuration.modelId,
			reasoning: { effort: "medium" },
			stream: true,
		}),
	});
	await expect(response.text()).resolves.toContain("response.completed");
	expect(cancelled).toBe(true);
	expect(proxy.snapshot()).toMatchObject({
		observedTokens: 110,
		stopped: false,
	});
});
it("allows one in-flight token overshoot then stops before another request", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => stream(1100));
	const proxy = await start(transport);
	await (await request(proxy.url)).text();
	expect((await request(proxy.url)).status).toBe(429);
	expect(proxy.snapshot().observedTokens).toBe(1110);
});
it("fails closed on missing usage and does not retry upstream", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response('data: {"type":"response.created"}\n\n'));
	const proxy = await start(transport);
	await (await request(proxy.url)).text();
	expect((await request(proxy.url)).status).toBe(429);
	expect(proxy.snapshot().stopped).toBe(true);
	expect(transport).toHaveBeenCalledTimes(1);
});
it("rejects model, reasoning, auth and endpoint changes before inference", async () => {
	const transport = vi.fn<typeof fetch>();
	const proxy = await start(transport);
	expect((await request(proxy.url, {}, "wrong")).status).toBe(401);
	expect((await request(proxy.url.replace("responses", "models"))).status).toBe(
		404,
	);
	expect((await request(proxy.url, { model: "different" })).status).toBe(400);
	expect(transport).not.toHaveBeenCalled();
});
