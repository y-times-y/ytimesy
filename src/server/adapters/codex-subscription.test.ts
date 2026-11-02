import { createServer } from "node:http";
import { generateText, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";
import {
	apiModelFailureMessage,
	SubscriptionUsageLimitReached,
	subscriptionUsageLimitMessage,
	usageLimitReset,
} from "#/domain/api-turn-failure";
import { modelContextBudget } from "../services/api-agent-context";
import { runModelAgentStep } from "../services/model-agent-loop";
import {
	codexSubscriptionCatalog,
	codexSubscriptionModel,
	forgetSubscriptionConnectionsForTests,
	readCodexSubscriptionUsage,
	subscriptionLimits,
	warmCodexSubscriptionCatalog,
} from "./codex-subscription";
import { withDatabaseScope } from "./database-scope";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connected: vi.fn() }));
vi.mock("../auth/codex-managed-auth", () => ({
	codexExternalTokens: mocks.auth,
	hasManagedCodexAuth: mocks.connected,
}));
beforeEach(() => {
	vi.restoreAllMocks();
	mocks.auth.mockReset().mockImplementation(async (userId: string) => ({
		accessToken: `token-${userId}`,
		chatgptAccountId: `account-${userId}`,
	}));
	mocks.connected.mockReset().mockResolvedValue(true);
	forgetSubscriptionConnectionsForTests();
});

it("reports bounded catalog HTTP diagnostics without exposing provider bodies", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("private-upstream-body", { status: 403 }),
	);
	await expect(codexSubscriptionCatalog("metadata-http-owner")).rejects.toThrow(
		"metadata was rejected (HTTP 403)",
	);
});

it("distinguishes catalog timeout from an inference failure", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new DOMException("private destination", "TimeoutError"),
	);
	await expect(
		codexSubscriptionCatalog("metadata-timeout-owner"),
	).rejects.toThrow("metadata failed (timeout). No inference was started");
});

it("does not follow subscription redirects or attempt to solve access challenges", async () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(null, {
			status: 302,
			headers: { location: "https://untrusted.example/login" },
		}),
	);
	await expect(codexSubscriptionCatalog("redirect-owner")).rejects.toThrow(
		"HTTP 302",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
	fetch.mockResolvedValue(
		new Response("private challenge body", {
			status: 403,
			headers: { "cf-mitigated": "challenge" },
		}),
	);
	await expect(codexSubscriptionCatalog("challenge-owner")).rejects.toThrow(
		"access-challenge",
	);
});

it("keeps subscription cache routing stable per account and chat through the real SDK", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url) => {
			if (String(url).includes("/models"))
				return new Response(
					JSON.stringify({
						models: [{ slug: "cached-model", context_window: 272000 }],
					}),
				);
			throw new Error("fixture-stop");
		});
	const runtime = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-one",
	);
	const same = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-one",
	);
	const other = await codexSubscriptionModel(
		"cache-owner",
		"cached-model",
		"low",
		false,
		"chat-two",
	);
	const settings = runtime.requestSettings("instructions");
	expect(runtime.prefetchInitialReads).toBe(true);
	const key = settings.providerOptions.openai.promptCacheKey;
	expect(key).toMatch(/^[a-f0-9]{64}$/);
	expect(
		same.requestSettings("instructions").providerOptions.openai.promptCacheKey,
	).toBe(key);
	expect(
		other.requestSettings("instructions").providerOptions.openai.promptCacheKey,
	).not.toBe(key);
	await expect(
		generateText({
			model: runtime.model,
			prompt: "unchanged",
			maxRetries: 0,
			...settings,
		}),
	).rejects.toThrow("fixture-stop");
	const request = fetch.mock.calls.at(-1)?.[1];
	expect(new Headers(request?.headers).get("session-id")).toBe(key);
	expect(new Headers(request?.headers).get("connection")).toBe("close");
	expect(JSON.parse(request?.body as string).prompt_cache_key).toBe(key);
	expect(JSON.parse(request?.body as string).parallel_tool_calls).toBe(true);
	mocks.auth.mockResolvedValue({
		accessToken: "different-account-token",
		chatgptAccountId: "different-account",
	});
	await expect(
		generateText({
			model: runtime.model,
			prompt: "unchanged",
			maxRetries: 0,
			...settings,
		}),
	).rejects.toThrow("account changed");
});

it("does not retain idle subscription sockets between long model steps", async () => {
	const realFetch = globalThis.fetch;
	const connections = new Set<unknown>();
	const headers: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		connections.add(request.socket);
		headers.push(request.headers.connection);
		request.resume();
		if (request.url === "/models") {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ models: [{ slug: "socket-fixture" }] }));
		} else {
			response.setHeader("Content-Type", "text/event-stream");
			response.end("data: [DONE]\n\n");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture port");
	const origin = `http://127.0.0.1:${address.port}`;
	vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
		realFetch(
			`${origin}/${String(url).includes("/models") ? "models" : "responses"}`,
			init,
		),
	);
	try {
		const runtime = await codexSubscriptionModel(
			"socket-owner",
			"socket-fixture",
		);
		if (typeof runtime.model === "string")
			throw new Error("Expected concrete model");
		for (let index = 0; index < 2; index++) {
			const response = await runtime.model.doStream({
				prompt: [
					{ role: "user", content: [{ type: "text", text: "fixture" }] },
				],
			});
			const reader = response.stream.getReader();
			try {
				while (!(await reader.read()).done) {
					/* Drain the actual SDK stream before starting another request. */
				}
			} finally {
				reader.releaseLock();
			}
		}
		expect(headers).toEqual(["close", "close", "close"]);
		expect(connections.size).toBe(3);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

it("uses the account catalog and requested reasoning without advertising unsupported fast mode", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [
					{
						slug: "modern",
						display_name: "Modern Model",
						context_window: 272000,
						auto_compact_token_limit: null,
						supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
						default_reasoning_level: "low",
					},
				],
			}),
		),
	);
	const models = await codexSubscriptionCatalog("reasoning-owner");
	expect(models[0].label).toBe("Modern Model");
	expect(models[0].supportsFastMode).toBeUndefined();
	expect(models[0].speeds).toBeUndefined();
	const runtime = await codexSubscriptionModel(
		"reasoning-owner",
		"modern",
		"high",
	);
	expect(runtime.contextWindow).toBe(272000);
	expect(runtime).not.toHaveProperty("workingContextTokens");
	expect(runtime).not.toHaveProperty("coordinationWorkingContextTokens");
	expect(runtime.autoCompactTokenLimit).toBeUndefined();
	expect(runtime.compact).toBeTypeOf("function");
	expect(
		runtime.requestSettings("instructions").providerOptions.openai
			.reasoningEffort,
	).toBe("high");
	await expect(
		codexSubscriptionModel("reasoning-owner", "modern", "ultra"),
	).rejects.toThrow("reasoning");
	await expect(
		codexSubscriptionModel("reasoning-owner", "modern", "low", true),
	).rejects.toThrow("Fast mode");
	mocks.connected.mockResolvedValue(false);
	await expect(codexSubscriptionCatalog("reasoning-owner")).rejects.toThrow(
		"Connect Codex",
	);
});
it("offers fast mode where the plan's catalog lists the priority tier, and sends it", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [
					{ slug: "tiered", service_tiers: [{ id: "priority" }] },
					{ slug: "legacy", additional_speed_tiers: ["fast"] },
					{ slug: "plain" },
				],
			}),
		),
	);
	const models = await codexSubscriptionCatalog("fast-owner");
	expect(models.map((model) => model.speeds)).toEqual([
		[{ id: "fast" }],
		[{ id: "fast" }],
		undefined,
	]);
	const fast = await codexSubscriptionModel(
		"fast-owner",
		"tiered",
		undefined,
		true,
	);
	expect(fast.requestSettings("x").providerOptions.openai.serviceTier).toBe(
		"priority",
	);
	const standard = await codexSubscriptionModel("fast-owner", "tiered");
	expect(
		standard.requestSettings("x").providerOptions.openai,
	).not.toHaveProperty("serviceTier");
	await expect(
		codexSubscriptionModel("fast-owner", "plain", undefined, true),
	).rejects.toThrow("Fast mode");
});

it("offers the plan's larger window where max_context_window exceeds the standard one, and budgets against it", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [
					{
						slug: "wide",
						context_window: 272_000,
						max_context_window: 872_000,
						auto_compact_token_limit: 240_000,
					},
					{
						slug: "fixed",
						context_window: 272_000,
						max_context_window: 272_000,
					},
					{ slug: "plain", context_window: 272_000 },
				],
			}),
		),
	);
	const models = await codexSubscriptionCatalog("window-owner");
	expect(models.map((model) => model.contextWindow)).toEqual([
		{
			standard: 272_000,
			alternate: 872_000,
			note: "Longer chats use your plan's limits faster",
		},
		undefined,
		undefined,
	]);
	const standard = await codexSubscriptionModel(
		"window-owner",
		"wide",
		undefined,
		false,
		"chat",
	);
	expect(standard).toMatchObject({
		contextWindow: 272_000,
		autoCompactTokenLimit: 240_000,
	});
	const large = await codexSubscriptionModel(
		"window-owner",
		"wide",
		undefined,
		false,
		"chat",
		true,
	);
	// The catalog's compaction limit was set for the standard window.
	expect(large.contextWindow).toBe(872_000);
	expect(large.autoCompactTokenLimit).toBeUndefined();
	// Nothing about the window is sent: Codex applies it to local limits only.
	expect(large.requestSettings("x")).toEqual(standard.requestSettings("x"));
	const budget = (runtime: typeof large) =>
		modelContextBudget({
			contextWindow: runtime.contextWindow,
			autoCompactTokenLimit: runtime.autoCompactTokenLimit,
			maxOutputTokens: 32_000,
		}).compactAtTokens;
	expect(budget(standard)).toBeLessThanOrEqual(240_000);
	expect(budget(large)).toBeGreaterThan(600_000);
	expect(budget(large)).toBeLessThan(872_000);
	await expect(
		codexSubscriptionModel(
			"window-owner",
			"fixed",
			undefined,
			false,
			undefined,
			true,
		),
	).rejects.toThrow("larger context window");
});

it.each([
	{ measuredTokens: 70_000, providerLimit: null, compacted: false },
	{ measuredTokens: 210_000, providerLimit: null, compacted: true },
	{ measuredTokens: 70_000, providerLimit: 60_000, compacted: true },
])(
	"uses provider context pressure rather than a fixed 64K checkpoint ($measuredTokens, $providerLimit)",
	async ({ measuredTokens, providerLimit, compacted }) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "context-policy",
							context_window: 272_000,
							auto_compact_token_limit: providerLimit,
						},
					],
				}),
			),
		);
		const runtime = await codexSubscriptionModel(
			`context-owner-${measuredTokens}-${providerLimit}`,
			"context-policy",
		);
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 3,
									noCache: 3,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 2, text: 2, reasoning: 0 },
							},
						},
					],
				}),
			}),
		});
		const compact = vi.fn(async () => ({
			messages: [{ role: "assistant" as const, content: "Native checkpoint" }],
			usage: {
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				inputTokenDetails: {
					noCacheTokens: 10,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
			},
		}));
		const archive = vi.fn(async () => "archive:fixture");
		const restore = vi.fn(async (messages: import("ai").ModelMessage[]) => [
			...messages,
			{ role: "assistant" as const, content: "Restored exact instructions" },
		]);
		await runModelAgentStep(
			{
				userId: "context-owner",
				modelId: "context-policy",
				instructions: "Follow repository instructions",
				messages: [{ role: "user", content: "Continue the implementation" }],
				tools: {},
				previousContext: {
					tokens: measuredTokens,
					modelContextWindow: 272_000,
				},
				signal: new AbortController().signal,
				archiveHistory: archive,
				restoreInstructions: restore,
				onEvent: async () => {},
				onStep: async () => {},
			},
			{ ...runtime, model, compact },
		);
		expect(compact).toHaveBeenCalledTimes(compacted ? 1 : 0);
		expect(archive).toHaveBeenCalledTimes(compacted ? 1 : 0);
		expect(restore).toHaveBeenCalledTimes(compacted ? 1 : 0);
		if (compacted)
			expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
				"Restored exact instructions",
			);
		const budget = modelContextBudget(runtime);
		expect(budget.compactAtTokens).toBeLessThan(budget.inputLimitTokens);
		if (providerLimit) expect(budget.compactAtTokens).toBe(providerLimit);
		else expect(budget.compactAtTokens).toBeGreaterThan(64_000);
	},
);
const window = {
	used_percent: 29,
	limit_window_seconds: 604800,
	reset_at: 123456,
};
it("normalizes account windows, preserves reset time and missing secondary window", () => {
	expect(
		subscriptionLimits(
			{ rate_limit: { primary_window: window, secondary_window: null } },
			1000,
		),
	).toEqual({
		updatedAt: 1,
		limits: {
			rateLimitsByLimitId: {
				codex: {
					limitId: "codex",
					limitName: undefined,
					primary: {
						usedPercent: 29,
						windowDurationMins: 10080,
						resetsAt: 123456,
					},
					secondary: null,
				},
			},
		},
	});
});
it("rejects malformed percentages instead of inventing usage", () => {
	expect(() =>
		subscriptionLimits({
			rate_limit: { primary_window: { ...window, used_percent: 101 } },
		}),
	).toThrow();
});
it("scopes every metadata request to its authenticated owner and returns no secrets", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ rate_limit: { primary_window: window } }),
				),
		);
	const usage = await readCodexSubscriptionUsage("alice");
	expect(fetch).toHaveBeenCalledWith(
		"https://chatgpt.com/backend-api/wham/usage",
		expect.objectContaining({
			redirect: "manual",
		}),
	);
	expect(
		Object.fromEntries(new Headers(fetch.mock.calls[0][1]?.headers)),
	).toMatchObject({
		authorization: "Bearer token-alice",
		"chatgpt-account-id": "account-alice",
		accept: "application/json",
		"user-agent": "ytimesy/1.0",
		connection: "close",
	});
	expect(JSON.stringify(usage)).not.toContain("token-alice");
	await readCodexSubscriptionUsage("bob");
	expect(mocks.auth).toHaveBeenLastCalledWith("bob");
});
it("does not query the provider for disconnected users", async () => {
	mocks.connected.mockResolvedValue(false);
	expect(await readCodexSubscriptionUsage("alice")).toBeUndefined();
	expect(mocks.auth).not.toHaveBeenCalled();
});
it("does not silently use another model when the catalog has no match", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [{ slug: "different", context_window: 272000 }],
			}),
		),
	);
	await expect(codexSubscriptionModel("alice", "selected")).rejects.toThrow(
		"no longer available on your current Codex plan",
	);
});

it("stops at a spent plan allowance instead of retrying a rate limit", async () => {
	const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600 + 15 * 60;
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url) => {
			if (String(url).includes("/models"))
				return new Response(
					JSON.stringify({
						models: [{ slug: "limited-model", context_window: 272000 }],
					}),
				);
			return new Response(
				JSON.stringify({
					error: {
						type: "usage_limit_reached",
						plan_type: "plus",
						resets_at: resetsAt,
					},
				}),
				{ status: 429 },
			);
		});
	const runtime = await codexSubscriptionModel(
		"limited-owner",
		"limited-model",
		"low",
	);
	const failure = streamText({
		model: runtime.model,
		prompt: "continue",
		maxRetries: 4,
		...runtime.requestSettings("instructions"),
	});
	let caught: unknown;
	try {
		for await (const part of failure.fullStream)
			if (part.type === "error") throw part.error;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SubscriptionUsageLimitReached);
	expect((caught as Error).message).toMatch(
		/usage is used up\. It resets in 2 h 1[45] min/,
	);
	expect(apiModelFailureMessage(caught)).toBe((caught as Error).message);
	expect(
		fetch.mock.calls.filter(([url]) => String(url).includes("/responses")),
	).toHaveLength(1);
});

it("resends a request whose 200 response had no body, and never a started stream", async () => {
	// rl-tests-sol failed on "Failed to process successful response": the
	// SDK's EmptyResponseBodyError for a 200 without a body. Nothing streamed.
	const sse = [
		{
			type: "response.created",
			response: { id: "r", created_at: 1, model: "m" },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg" },
		},
		{ type: "response.output_text.delta", item_id: "msg", delta: "done" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: "msg" },
		},
		{
			type: "response.completed",
			response: { usage: { input_tokens: 1, output_tokens: 1 } },
		},
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	let inference = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).includes("/models"))
			return new Response(
				JSON.stringify({
					models: [{ slug: "empty-model", context_window: 272000 }],
				}),
			);
		inference++;
		if (inference === 1) return new Response(null, { status: 200 });
		return new Response(sse, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const runtime = await codexSubscriptionModel(
		"empty-owner",
		"empty-model",
		"low",
	);
	const result = streamText({
		model: runtime.model,
		prompt: "continue",
		maxRetries: 4,
		...runtime.requestSettings("instructions"),
	});
	expect(await result.text).toBe("done");
	expect(inference).toBe(2);
	// With retries off (as after output), the empty body still fails visibly.
	inference = 0;
	const once = streamText({
		model: runtime.model,
		prompt: "continue",
		maxRetries: 0,
		...runtime.requestSettings("instructions"),
	});
	let caught: unknown;
	try {
		for await (const part of once.fullStream)
			if (part.type === "error") throw part.error;
	} catch (error) {
		caught = error;
	}
	expect((caught as Error).message).toMatch(/no response body/);
});

it("reads the reset time only from a usage-limit body", () => {
	expect(
		usageLimitReset('{"error":{"type":"usage_limit_reached","resets_at":10}}'),
	).toEqual(new Date(10_000));
	expect(
		usageLimitReset('{"error":{"type":"usage_limit_reached"}}'),
	).toBeNull();
	expect(
		usageLimitReset('{"error":{"type":"rate_limit_exceeded"}}'),
	).toBeUndefined();
	expect(usageLimitReset("not json")).toBeUndefined();
	expect(subscriptionUsageLimitMessage(null)).toContain(
		"resets when your plan's usage window renews",
	);
});

it("sends a step's first request with the token read while building it, and reads again after", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).includes("/models"))
			return new Response(
				JSON.stringify({ models: [{ slug: "reuse-model" }] }),
			);
		throw new Error("fixture-stop");
	});
	const runtime = await codexSubscriptionModel(
		"reuse-owner",
		"reuse-model",
		"low",
	);
	const reads = mocks.auth.mock.calls.length;
	const send = () =>
		generateText({
			model: runtime.model,
			prompt: "hello",
			maxRetries: 0,
			...runtime.requestSettings("instructions"),
		});
	await expect(send()).rejects.toThrow("fixture-stop");
	expect(mocks.auth.mock.calls.length).toBe(reads);
	await expect(send()).rejects.toThrow("fixture-stop");
	expect(mocks.auth.mock.calls.length).toBe(reads + 1);
});

it("answers from the last catalog past a minute while it refreshes, and loads again once it is too old", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const catalog = (slug: string) =>
			new Response(JSON.stringify({ models: [{ slug }] }));
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(catalog("first"))
			.mockResolvedValueOnce(catalog("second"))
			.mockResolvedValueOnce(catalog("third"));
		const owner = "stale-catalog-owner";
		expect((await codexSubscriptionCatalog(owner))[0].id).toBe("first");
		// Fresh: no request.
		expect((await codexSubscriptionCatalog(owner))[0].id).toBe("first");
		expect(fetch).toHaveBeenCalledTimes(1);
		// Stale: answered at once from the last read, refreshed alongside.
		vi.setSystemTime(Date.now() + 90_000);
		expect((await codexSubscriptionCatalog(owner))[0].id).toBe("first");
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await vi.waitFor(async () =>
			expect((await codexSubscriptionCatalog(owner))[0].id).toBe("second"),
		);
		// Too old to serve: loaded before answering.
		vi.setSystemTime(Date.now() + 11 * 60_000);
		expect((await codexSubscriptionCatalog(owner))[0].id).toBe("third");
		expect(fetch).toHaveBeenCalledTimes(3);
	} finally {
		vi.useRealTimers();
	}
});

it("reads a step's token once for its catalog and model runtime, and again once it is not recent", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				async () =>
					new Response(JSON.stringify({ models: [{ slug: "shared-model" }] })),
			);
		const owner = "shared-token-owner";
		warmCodexSubscriptionCatalog(owner);
		const runtime = await codexSubscriptionModel(owner, "shared-model", "low");
		expect(runtime.contextWindow).toBeUndefined();
		// One read served the catalog request and the runtime.
		expect(mocks.auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(
			new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
		).toBe(`Bearer token-${owner}`);
		vi.setSystemTime(Date.now() + 21_000);
		await codexSubscriptionModel(owner, "shared-model", "low");
		expect(mocks.auth).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
	}
});

it("does not keep a failed token read", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () => new Response(JSON.stringify({ models: [{ slug: "m" }] })),
	);
	const owner = "failed-token-owner";
	mocks.auth.mockRejectedValueOnce(new Error("database unavailable"));
	await expect(codexSubscriptionModel(owner, "m", "low")).rejects.toThrow();
	const runtime = await codexSubscriptionModel(owner, "m", "low");
	expect(runtime.model).toBeDefined();
});

it("never waits on another invocation's pending catalog read", async () => {
	// On Workers that read's I/O belongs to its request; if the request ends
	// first, awaiting it hangs the send that shares it.
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementationOnce(() => new Promise<Response>(() => {}))
		.mockImplementation(
			async () => new Response(JSON.stringify({ models: [{ slug: "own" }] })),
		);
	const owner = "cross-invocation-owner";
	const url = "postgres://user:pass@127.0.0.1:1/none";
	await withDatabaseScope(
		url,
		async () => {
			warmCodexSubscriptionCatalog(owner);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		},
		null,
	);
	const models = await withDatabaseScope(
		url,
		() => codexSubscriptionCatalog(owner),
		null,
	);
	expect(models[0].id).toBe("own");
	expect(fetch).toHaveBeenCalledTimes(2);
});
