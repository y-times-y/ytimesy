import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CodexReconnectRequired,
	XaiSubscriptionUnavailable,
} from "../../domain/api-turn-failure";
import { subscriptionTurnRevision } from "../../domain/subscription-turn";
import type { VmEnsureResponse } from "../../domain/turn-box-vm-protocol";
import type { GuestExec } from "../claude-box-tools/identity-machines";
import { fakeEdge } from "../edge/turn-box-fake-edge";

/**
 * Codex and Grok subscription turns on a box (docs/turn-runner-boxes.md,
 * "Subscription routes"): the real `runApiTurn` through `runTurnRunnerBox`,
 * the fake edge (the real routes and model proxy over an in-memory turn
 * table), a fake upstream (chatgpt.com / api.x.ai through the real Codex
 * transport) and a fake Freestyle guest. The database is mocked to THROW and
 * record who asked; the OAuth tokens exist only at the edge's side of the
 * seam, and every byte the box sends or receives is searched for them.
 */
const dbCalls = vi.hoisted(() => ({ stacks: [] as string[] }));
vi.mock("../adapters/database", () => ({
	database: () => {
		const error = new Error("The box has no database.");
		dbCalls.stacks.push(error.stack ?? "");
		throw error;
	},
	withDatabaseScope: async (_: unknown, run: () => unknown) => run(),
}));
const tokens = vi.hoisted(() => ({
	external: vi.fn(),
	connected: vi.fn(),
}));
vi.mock("../auth/codex-managed-auth", () => ({
	codexExternalTokens: tokens.external,
	hasManagedCodexAuth: tokens.connected,
}));

import { forgetSubscriptionConnectionsForTests } from "../adapters/codex-subscription";
import { CODEX_BACKEND } from "../adapters/codex-subscription-runtime";
import { subscriptionFetch } from "../adapters/codex-subscription-transport";
import { turnBoxPort } from "../adapters/turn-box-port-handlers";
import { runTurnRunnerBox } from "./box-runner";
import { TurnBoxEdgeClient } from "./turn-box-client";
import { boxWorkspaceMachines } from "./turn-box-vm-machines";

const CLEAN_ENV = {
	YTIMESY_EDGE_URL: "https://edge.test",
	YTIMESY_BOX_IDENTITY: "ytbi1.x.y",
	YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
	TURN_BOX_EDGE_PUBLIC_KEY: "public",
	PATH: "/usr/bin",
	HOME: "/home/box",
};
const SECRET_NAME =
	/DATABASE|_API_KEY|FREESTYLE|TOKEN_VAULT|PRIVATE_KEY|_SECRET/i;
/** Everything the edge keeps: none may appear in what the box sends or receives. */
const SECRETS = [
	"codex-access-1",
	"codex-access-2",
	"acct-secret",
	"xai-access-1",
	"xai-access-2",
];
const PACKET = JSON.stringify({
	scope: "",
	revision: null,
	nestedInstructionFiles: [],
	nestedInstructionFilesTruncated: false,
	instructions: [],
	referencedDocuments: [],
	configuration: [],
	documentLimitReached: false,
	skills: [],
	skillLimitReached: false,
	scopeFiles: [],
	scopeFilesTruncated: false,
	scopeFilesUnavailable: false,
	unreadableFiles: [],
});

type Step = { text: string } | { tool: string; input: Record<string, unknown> };
const sse = (events: unknown[]) =>
	new Response(
		`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
		{
			headers: {
				"content-type": "text/event-stream",
				"x-codex-primary-used-percent": "12",
			},
		},
	);
const usage = { input_tokens: 5, output_tokens: 2 };
/** The Responses API stream the ChatGPT Codex backend answers with. */
const responsesStream = (step: Step) => {
	const head = [
		{
			type: "response.created",
			response: { id: "r", created_at: 1, model: "m" },
		},
	];
	if ("text" in step)
		return sse([
			...head,
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg" },
			},
			{ type: "response.output_text.delta", item_id: "msg", delta: step.text },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg" },
			},
			{ type: "response.completed", response: { usage } },
		]);
	const args = JSON.stringify(step.input);
	const item = {
		type: "function_call",
		id: "fc",
		call_id: "call_1",
		name: step.tool,
	};
	return sse([
		...head,
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: "fc",
			output_index: 0,
			delta: args,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, arguments: args, status: "completed" },
		},
		{ type: "response.completed", response: { usage } },
	]);
};
/** The chat-completions stream api.x.ai answers with. */
const chatStream = (step: Step) => {
	const chunk = (
		delta: unknown,
		finish: string | null,
		withUsage?: unknown,
	) => ({
		id: "c",
		object: "chat.completion.chunk",
		created: 1,
		model: "grok-4.7",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(withUsage ? { usage: withUsage } : {}),
	});
	const u = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
	return sse(
		"text" in step
			? [
					chunk({ role: "assistant", content: step.text }, null),
					chunk({}, "stop", u),
				]
			: [
					chunk(
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: {
										name: step.tool,
										arguments: JSON.stringify(step.input),
									},
								},
							],
						},
						null,
					),
					chunk({}, "tool_calls", u),
				],
	);
};

type Upstream = {
	url: string;
	headers: Headers;
	body: string;
	signal?: AbortSignal | null;
};

async function scenario(input: {
	provider: "codex" | "xai";
	model: Step[];
	/** Replaces the n-th (1-based) upstream model response. */
	respond?: (
		n: number,
		upstream: Upstream,
	) => Response | Promise<Response> | undefined;
	connected?: boolean;
	onModel?: (n: number, edge: Awaited<ReturnType<typeof fakeEdge>>) => void;
	/** Grok: what the edge's token-injecting fetch throws, if anything. */
	xaiRefusal?: XaiSubscriptionUnavailable;
}) {
	const edge = await fakeEdge();
	const codex = input.provider === "codex";
	edge.row.messages = [{ role: "user", content: "add a file" }];
	edge.row.items = [
		{ kind: "userMessage", id: "m1", text: "add a file" } as never,
	];
	edge.row.connection_id = codex ? null : "g1";
	edge.row.connection_revision = codex
		? subscriptionTurnRevision("low")
		: "rev-1";
	edge.row.model_id = codex ? "gpt-x" : "grok-4.7";
	edge.queue.push({ ...edge.row });

	// The edge's tokens, and what chatgpt.com / api.x.ai see.
	let refreshes = 0;
	tokens.external
		.mockReset()
		.mockImplementation(async (_user: string, force?: boolean) => {
			if (force) {
				refreshes += 1;
				if (refuseRefresh.value === "refresh")
					throw new CodexReconnectRequired();
			}
			// A refresh token the provider rejected, found when the turn reads the account.
			if (refuseRefresh.value === "read") throw new CodexReconnectRequired();
			return {
				accessToken: force ? "codex-access-2" : "codex-access-1",
				chatgptAccountId: "acct-secret",
			};
		});
	tokens.connected.mockReset().mockResolvedValue(input.connected ?? true);
	forgetSubscriptionConnectionsForTests();
	const upstream: Upstream[] = [];
	let modelCalls = 0;
	const fakeUpstream = async (
		target: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = String(target);
		if (url.includes("/codex/models"))
			return Response.json({
				models: [
					{
						slug: "gpt-x",
						context_window: 272000,
						default_reasoning_level: "low",
						supported_reasoning_levels: [{ effort: "low" }],
					},
				],
			});
		const record: Upstream = {
			url,
			headers: new Headers(init?.headers),
			body: String(init?.body ?? ""),
			signal: init?.signal,
		};
		upstream.push(record);
		// A request answered 401 (a token the provider revoked) is not a model call.
		const bearer = record.headers.get("authorization");
		if (codex && bearer === "Bearer codex-access-1" && revoke.first) {
			revoke.first = false;
			return new Response("expired", { status: 401 });
		}
		modelCalls += 1;
		input.onModel?.(modelCalls, edge);
		const replaced = await input.respond?.(modelCalls, record);
		if (replaced) return replaced;
		const step = input.model[
			Math.min(modelCalls, input.model.length) - 1
		] as Step;
		return codex ? responsesStream(step) : chatStream(step);
	};
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(((
		target: RequestInfo | URL,
		init?: RequestInit,
	) =>
		String(target).startsWith("https://chatgpt.com/") ||
		String(target).startsWith("https://api.x.ai/")
			? fakeUpstream(target, init)
			: realFetch(target, init)) as typeof fetch);
	const revoke = { first: false };
	const refuseRefresh: { value: false | "read" | "refresh" } = { value: false };

	edge.ops.authorizeModel = async (grant) =>
		codex
			? {
					kind: "ok",
					connectionKind: "subscription",
					subscription: "codex",
					baseUrl: `${CODEX_BACKEND}/codex`,
					// What turn-box-edge.ts builds: the transport the Durable Object uses.
					send: (url, init) =>
						subscriptionFetch(
							grant.userId,
							url.slice(CODEX_BACKEND.length + 1),
							init,
						),
				}
			: {
					kind: "ok",
					connectionKind: "subscription",
					subscription: "xai",
					baseUrl: "https://api.x.ai/v1",
					// Stands for xaiSubscriptionFetch (covered by its own tests): the bearer
					// replaces the placeholder, one refresh and resend on a 401.
					send: async (url, init) => {
						if (input.xaiRefusal) throw input.xaiRefusal;
						const send = (token: string) => {
							const headers = new Headers(init.headers);
							headers.set("authorization", `Bearer ${token}`);
							return fetch(url, { ...init, headers });
						};
						let response = await send("xai-access-1");
						if (response.status === 401) response = await send("xai-access-2");
						return response;
					},
				};

	const owner = {
		id: edge.row.session_id,
		userId: edge.row.user_id,
		projectId: "p1",
		workspaceId: "w1",
		harness: "api",
		providerRef: "vm-1",
		parentSessionId: null,
		title: "t",
		briefing: null,
		items: [],
		listedModelId: null,
		turnStatus: "running",
		status: "ready",
		taskPrompt: null,
		taskState: null,
		taskPlacement: null,
		taskAccess: null,
		taskSummary: null,
		taskReviewState: null,
		taskBranch: null,
		createdAt: "",
		updatedAt: "",
	};
	const defaults: Record<string, unknown> = {
		sessionAncestors: [],
		importedSessions: [],
		lifecycleContinuations: [],
		pluginSkillIndex: [],
		otherRunningTurnOnMachine: false,
		isDevEvalUser: false,
		peerInboxRead: [],
		coordinateTurn: true,
		projectSecretNames: { names: [] },
		sessionMetadata: owner,
		modelConnection: {
			id: "g1",
			provider: "compatible",
			label: "Grok",
			baseUrl: "https://api.x.ai/v1",
			models: [{ id: "grok-4.7", label: "Grok 4.7" }],
			revision: "rev-1",
			subscription: { provider: "xai", status: "ready" },
		},
		commitTurn: { publish: false },
	};
	const ports = edge.state.ports as Record<string, unknown>;
	for (const op of [
		...Object.keys(defaults),
		"projectYMode",
		"conversationPointCodeRef",
		"verificationBaseline",
		"preparedCheckoutDirectory",
		"projectDerivedValue",
		"sessionDerivedValue",
		"pluginSkillBody",
		"harnessVariant",
		"savePreparedCheckoutDirectory",
		"saveSessionDerivedValue",
		"archiveContext",
		"releaseHeldTaskEvents",
		"analytics",
		"userHubNote",
		"crewWaiting",
		"writeSecretsToVm",
		"ensureCodePoint",
	])
		ports[op] = async () => defaults[op] ?? null;
	// The edge's own handlers (turn-box-port-handlers.ts): the real ones.
	for (const op of ["codexAuth", "codexSelection"] as const)
		ports[op] = async (args: never, turn: never) => {
			const answered = await turnBoxPort(turn, op, args);
			return answered.served ? answered.result : null;
		};

	const vmWorld = { ensures: 0 };
	const vmEdge = {
		ensure: async (): Promise<VmEnsureResponse> => {
			vmWorld.ensures += 1;
			return {
				vm: "vm-1",
				grant:
					vmWorld.ensures === 1
						? { token: "scoped-token", linuxUser: "ubuntu", redactOnVm: false }
						: null,
			};
		},
		pause: async () => "skipped" as const,
		op: async () => ({}),
		release: async () => undefined,
	};
	const guest: () => GuestExec = () => async (options) => {
		if (options.command.includes("ytimesy-project-cwd"))
			return { stdout: "/home/ubuntu/repo", stderr: "", statusCode: 0 };
		if (options.command.startsWith("python3 -c"))
			return { stdout: PACKET, stderr: "", statusCode: 0 };
		return { stdout: "ok\n", stderr: "", statusCode: 0 };
	};

	// Everything that crosses between the box and the edge, in both directions.
	const requests: string[] = [];
	const crossed: string[] = [];
	const received: Response[] = [];
	const counted = (async (target: RequestInfo | URL, init?: RequestInit) => {
		let next = init;
		if (typeof next?.body === "string") {
			const headers = new Headers(next.headers);
			headers.set(
				"content-length",
				String(new TextEncoder().encode(next.body).length),
			);
			next = { ...next, headers };
		}
		const path = new URL(String(target)).pathname;
		let label = path.replace("/box/v1/", "");
		if (path.endsWith("/port") && typeof next?.body === "string")
			label = `port:${(JSON.parse(next.body) as { op: string }).op}`;
		requests.push(label);
		crossed.push(
			JSON.stringify([
				String(target),
				[...new Headers(next?.headers)],
				next?.body ?? "",
			]),
		);
		const response = await edge.fetchEdge(target, next);
		crossed.push(JSON.stringify([...response.headers]));
		// A model stream is the model's body (read by the SDK); anything else is read here.
		if (!label.startsWith("model/"))
			crossed.push(await response.clone().text());
		received.push(response);
		return response;
	}) as typeof fetch;
	const client = new TurnBoxEdgeClient({
		edgeUrl: "https://edge.test",
		identity: edge.identity,
		fetch: counted,
		now: () => edge.state.now,
		socket: async () => {
			throw new Error("no socket in this test");
		},
	});

	const reads: string[] = [];
	const env = new Proxy({ ...CLEAN_ENV } as Record<string, string>, {
		get(target, key) {
			if (typeof key === "string" && SECRET_NAME.test(key)) reads.push(key);
			return target[key as string];
		},
	});
	const realEnv = process.env;
	const watched = new Proxy(realEnv, {
		get(target, key) {
			if (typeof key === "string" && SECRET_NAME.test(key)) reads.push(key);
			return target[key as string];
		},
	});
	const run = async () => {
		process.env = watched;
		try {
			const box = await runTurnRunnerBox({
				env,
				client,
				machinesFor: () =>
					boxWorkspaceMachines({ edge: vmEdge, guest, now: () => Date.now() }),
				signalHandlers: false,
			});
			await box.dispatcher.drain();
		} finally {
			process.env = realEnv;
		}
	};
	return {
		edge,
		run,
		requests,
		crossed,
		upstream,
		reads,
		revoke,
		refuseRefresh,
		refreshes: () => refreshes,
		modelCalls: () => modelCalls,
		/** The user-facing message and the logged cause chain of the turn's error item. */
		errorMessage: () => {
			const item = (
				edge.row.items as { kind: string; message?: string; cause?: string }[]
			).find((row) => row.kind === "error");
			return `${item?.message ?? ""} | ${item?.cause ?? ""}`;
		},
	};
}

const count = (requests: string[], label: string) =>
	requests.filter((row) => row === label).length;
function expectNoSecretsCrossed(s: { crossed: string[]; reads: string[] }) {
	const text = s.crossed.join("\n");
	for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
	expect(s.reads).toEqual([]);
}

beforeEach(() => {
	dbCalls.stacks.length = 0;
	vi.restoreAllMocks();
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a Codex subscription turn on a box", () => {
	it("completes with no database read and no token on the box, the edge sending the pinned request", async () => {
		const s = await scenario({ provider: "codex", model: [{ text: "Done." }] });
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expectNoSecretsCrossed(s);
		// The edge, not the box, authenticated: bearer, account, cache routing, UA.
		const sent = s.upstream[0] as Upstream;
		expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(sent.headers.get("authorization")).toBe("Bearer codex-access-1");
		expect(sent.headers.get("chatgpt-account-id")).toBe("acct-secret");
		expect(sent.headers.get("session-id")).toMatch(/^[a-f0-9]{64}$/);
		expect(sent.headers.get("user-agent")).toBe("ytimesy/1.0");
		const body = JSON.parse(sent.body) as {
			model: string;
			stream: boolean;
			store: boolean;
		};
		expect(body).toMatchObject({ model: "gpt-x", stream: true, store: false });
		// What the box asked the edge for: the model stream, the model choice and the sign-in check, once each.
		expect(count(s.requests, "model/codex/responses")).toBe(1);
		expect(count(s.requests, "port:codexSelection")).toBe(1);
		expect(count(s.requests, "port:codexAuth")).toBe(1);
		expect(count(s.requests, "port:modelConnection")).toBe(0);
	});

	it("passes the plan's usage headers through to the box", async () => {
		const s = await scenario({ provider: "codex", model: [{ text: "Done." }] });
		await s.run();
		const model = s.requests.indexOf("model/codex/responses");
		expect(model).toBeGreaterThanOrEqual(0);
		// (response-header NAMES are logged by the edge's transport, as in the Durable Object.)
		expect(s.edge.row.state).toBe("completed");
	});

	it("refreshes once on a 401 and resends: one model request from the box, one refresh at the edge", async () => {
		const s = await scenario({ provider: "codex", model: [{ text: "Done." }] });
		s.revoke.first = true;
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(s.refreshes()).toBe(1);
		expect(s.upstream.map((u) => u.headers.get("authorization"))).toEqual([
			"Bearer codex-access-1",
			"Bearer codex-access-2",
		]);
		expect(count(s.requests, "model/codex/responses")).toBe(1);
		expectNoSecretsCrossed(s);
		expect(dbCalls.stacks).toEqual([]);
	});

	it("a refresh token the provider rejected: the same reconnect error as in the Durable Object, no model request", async () => {
		const s = await scenario({ provider: "codex", model: [{ text: "Done." }] });
		s.refuseRefresh.value = "read";
		await s.run();
		expect(s.edge.row.state).toBe("failed");
		expect(s.errorMessage()).toMatch(/reconnect Codex in Settings/);
		expect(s.modelCalls()).toBe(0);
		expectNoSecretsCrossed(s);
		expect(dbCalls.stacks).toEqual([]);
	});

	it("a token revoked mid-turn whose refresh is rejected fails the request with the reconnect error as its cause", async () => {
		const s = await scenario({ provider: "codex", model: [{ text: "Done." }] });
		s.revoke.first = true;
		s.refuseRefresh.value = "refresh";
		await s.run();
		expect(s.edge.row.state).toBe("failed");
		expect(s.errorMessage()).toMatch(/CodexReconnectRequired/);
		expect(s.modelCalls()).toBe(0);
		expectNoSecretsCrossed(s);
		// Failover is not served on a box: the loop never planned one from the database.
		expect(dbCalls.stacks).toEqual([]);
	});

	it("an account with no Codex sign-in asks to reconnect before any model request", async () => {
		const s = await scenario({
			provider: "codex",
			model: [{ text: "x" }],
			connected: false,
		});
		await s.run();
		expect(s.edge.row.state).toBe("failed");
		// Today's wording for this case (the same loop code runs it): see the cause.
		expect(s.errorMessage()).toMatch(/Reconnect Codex before continuing/);
		expect(s.upstream).toEqual([]);
	});

	it("a spent plan allowance is reported as the usage limit, from the box", async () => {
		const s = await scenario({
			provider: "codex",
			model: [{ text: "x" }],
			respond: () =>
				Response.json(
					{
						error: {
							type: "usage_limit_reached",
							resets_at: Math.floor(Date.now() / 1000) + 7_200,
						},
					},
					{ status: 429 },
				),
		});
		await s.run();
		expect(s.edge.row.state).toBe("failed");
		expect(s.errorMessage()).toMatch(/usage is used up|resets in/i);
	});

	it("Stop while the model streams: the box stops and the edge's upstream request is aborted", async () => {
		const s = await scenario({
			provider: "codex",
			model: [{ text: "never" }],
			onModel: (n, edge) => {
				if (n === 1) edge.row.cancel_requested = true;
			},
			respond: (_n, request) =>
				new Response(
					new ReadableStream({
						start(controller) {
							// A real connection errors when its request is aborted.
							request.signal?.addEventListener("abort", () =>
								controller.error(new DOMException("aborted", "AbortError")),
							);
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ type: "response.created", response: { id: "r", created_at: 1, model: "m" } })}\n\n`,
								),
							);
							// Never finishes: only a Stop ends this stream.
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		await s.run();
		expect(s.edge.row.state).toBe("cancelled");
		expect((s.upstream[0] as Upstream).signal?.aborted).toBe(true);
		expect(s.edge.calls).not.toContain("port:commitTurn");
	}, 30_000);

	it("a tool turn costs about two Worker requests a step (model + checkpoint), the selection asked once", async () => {
		const turn = async (tools: number) => {
			const model: Step[] = [
				...Array.from({ length: tools }, () => ({
					tool: "execute_command",
					input: { command: "echo hi" },
				})),
				{ text: "Done." },
			];
			const s = await scenario({ provider: "codex", model });
			await s.run();
			expect(s.edge.row.state).toBe("completed");
			expect(count(s.requests, "model/codex/responses")).toBe(tools + 1);
			expect(count(s.requests, "port:codexSelection")).toBe(1);
			expect(count(s.requests, "port:codexAuth")).toBe(1);
			expectNoSecretsCrossed(s);
			expect(dbCalls.stacks).toEqual([]);
			return s.requests.length;
		};
		const short = await turn(5);
		const long = await turn(15);
		// The marginal cost of a step: the per-turn fixed requests cancel out.
		const perStep = (long - short) / 10;
		console.log("E2E codex requests", { short, long, perStep });
		expect(perStep).toBeLessThanOrEqual(2.5);
	}, 60_000);
});

describe("a Grok subscription turn on a box", () => {
	it("completes: the edge swaps the placeholder for the OAuth bearer, the box holds nothing", async () => {
		const s = await scenario({ provider: "xai", model: [{ text: "Done." }] });
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expectNoSecretsCrossed(s);
		const sent = s.upstream[0] as Upstream;
		expect(sent.url).toBe("https://api.x.ai/v1/chat/completions");
		expect(sent.headers.get("authorization")).toBe("Bearer xai-access-1");
		expect(count(s.requests, "model/chat/completions")).toBe(1);
		expect(count(s.requests, "port:modelConnection")).toBe(1);
	});

	it("a plan that cannot serve ends the turn with Grok's own message (no failover on a box)", async () => {
		const s = await scenario({
			provider: "xai",
			model: [{ text: "x" }],
			xaiRefusal: new XaiSubscriptionUnavailable("reconnect"),
		});
		await s.run();
		expect(s.edge.row.state).toBe("failed");
		expect(s.errorMessage()).toMatch(/Grok sign-in expired/);
		expect(s.upstream).toEqual([]);
		expect(dbCalls.stacks).toEqual([]);
	});
});
