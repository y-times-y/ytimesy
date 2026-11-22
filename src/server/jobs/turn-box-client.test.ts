import { describe, expect, it, vi } from "vitest";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import {
	TURN_BOX_IDENTITY_REFRESH_MS,
	TURN_BOX_IDENTITY_TTL_MS,
} from "#/domain/turn-box-grant";
import { TURN_BOX_REQUEST_BUDGET } from "#/domain/turn-box-protocol";
import { fakeEdge } from "../edge/turn-box-fake-edge";
import { answerTurnBoxSocketMessage } from "../edge/turn-box-socket";
import {
	type BoxSocket,
	TurnBoxEdgeClient,
	TurnBoxIdentityRejected,
	TurnBoxLeaseLost,
} from "./turn-box-client";

async function setup() {
	const edge = await fakeEdge();
	edge.queue.push({ ...edge.row });
	const requests: string[] = [];
	const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push(
			new URL(String(input instanceof Request ? input.url : input)).pathname,
		);
		return edge.fetchEdge(input, init);
	}) as typeof fetch;
	let clock = edge.state.now;
	const sockets: {
		socket: BoxSocket;
		pushed: string[];
		received: ((data: string) => void)[];
		sent: string[];
	}[] = [];
	const client = new TurnBoxEdgeClient({
		edgeUrl: "https://edge.test",
		identity: edge.identity,
		fetch: counted,
		now: () => clock,
		// A socket whose far end is the Durable Object's real message handler.
		socket: async () => {
			const received: ((data: string) => void)[] = [];
			const sent: string[] = [];
			const attachment = {
				userId: edge.row.user_id,
				sessionId: edge.row.session_id,
				turnId: edge.row.id,
				leaseId: edge.row.lease_id as string,
				boxId: "box-a",
			};
			const socket: BoxSocket = {
				send: (data) => {
					sent.push(data);
					void answerTurnBoxSocketMessage(attachment, data, edge.ops).then(
						({ reply }) => {
							for (const message of reply)
								for (const handler of received)
									handler(JSON.stringify(message));
						},
					);
				},
				close: () => undefined,
				onMessage: (handler) => received.push(handler),
				onClose: () => undefined,
			};
			sockets.push({ socket, pushed: [], received, sent });
			return socket;
		},
	});
	return {
		edge,
		client,
		requests,
		sockets,
		counted,
		tick: (ms: number) => {
			clock += ms;
			edge.state.now = clock;
		},
	};
}

describe("turn box client against the edge", () => {
	it("distinguishes an expired identity from a deferred registration", async () => {
		const { client, tick } = await setup();
		const registration = { capacity: 2, running: 0 };
		tick(TURN_BOX_IDENTITY_TTL_MS - TURN_BOX_IDENTITY_REFRESH_MS - 1);
		await expect(client.register(registration)).resolves.toBe(true);
		tick(TURN_BOX_IDENTITY_REFRESH_MS + 1);
		await expect(client.register(registration)).rejects.toThrow(
			TurnBoxIdentityRejected,
		);
	});

	it("keeps heartbeating and claiming after the bootstrap identity expires", async () => {
		const { client, edge, tick } = await setup();
		const heartbeat = { capacity: 3, running: 0 };
		await expect(client.register(heartbeat)).resolves.toBe(true);
		tick(TURN_BOX_IDENTITY_TTL_MS - TURN_BOX_IDENTITY_REFRESH_MS);
		await expect(client.register(heartbeat)).resolves.toBe(true);
		tick(TURN_BOX_IDENTITY_REFRESH_MS);
		await expect(client.register(heartbeat)).resolves.toBe(true);
		await expect(client.claim()).resolves.toMatchObject({
			turn: { id: edge.row.id },
		});

		tick(TURN_BOX_IDENTITY_TTL_MS - 2 * TURN_BOX_IDENTITY_REFRESH_MS);
		edge.state.revoked = true;
		await expect(client.register(heartbeat)).resolves.toBe(false);
		await expect(client.claim()).rejects.toThrow("Turn claim failed (403).");
	});

	it("checkpoints a history over the edge's body limit (sent gzipped), and the next step runs on the route a failover saved", async () => {
		const { client, edge } = await setup();
		expect(await client.register({ capacity: 2, running: 0 })).toBe(true);
		const session = await client.claim();
		const adapters = session?.adapters();
		// ~9 MB of items as JSON, over the 8 MB body limit uncompressed.
		const items = Array.from({ length: 3000 }, (_, index) => ({
			id: `i${index}`,
			kind: "agentMessage",
			text: `step ${index} `.repeat(300),
		}));
		expect(JSON.stringify(items).length).toBeGreaterThan(8 * 1024 * 1024);
		const failover = { route: { modelId: "m2" }, switches: 1 } as never;
		await adapters?.checkpointApiTurn(
			null,
			[{ role: "user", content: "hi" }],
			items as never,
			failover,
		);
		expect(edge.row.items).toHaveLength(3000);
		expect(session?.turn.failover).toEqual(failover);
	});

	it("a checkpoint the edge refuses fails the step instead of passing silently", async () => {
		const { client, edge } = await setup();
		expect(await client.register({ capacity: 2, running: 0 })).toBe(true);
		const session = await client.claim();
		edge.ops.checkpoint = async () => {
			throw new Error("down");
		};
		await expect(
			session?.adapters().checkpointApiTurn(null, [], [] as never),
		).rejects.toThrow("Turn box checkpoint failed");
	});

	it("claims a turn and runs the loop's writes through the grant, no secret needed", async () => {
		const { client, edge, requests } = await setup();
		expect(await client.register({ capacity: 2, running: 0 })).toBe(true);
		const session = await client.claim();
		expect(session?.turn.id).toBe(edge.row.id);
		expect(JSON.stringify(session?.turn)).not.toMatch(/postgres|sk-/);
		const adapters = session?.adapters();
		await adapters?.checkpointApiTurn(
			null,
			[{ role: "user", content: "hi" }],
			[{ id: "a" } as never],
		);
		expect(edge.row.items).toEqual([{ id: "a" }]);
		expect(await adapters?.renewApiTurn()).toBe(true);
		const history = await session?.history();
		expect(history?.messages).toHaveLength(1);
		// Unchanged since: served from the box's cache by version.
		expect((await session?.history())?.version).toBe(history?.version);
		// The loop's own reservation is a no-op: the proxy reserves per model call.
		await adapters?.reserveApiTokens("u", "s", 1000);
		expect(
			await adapters?.finalizeApiTurn(null, "completed", [
				{ id: "a" } as never,
			]),
		).toBe("completed");
		expect(requests.filter((path) => path.endsWith("/history"))).toHaveLength(
			2,
		);
	});

	it("returns null when no turn is queued", async () => {
		const { client, edge } = await setup();
		edge.queue.length = 0;
		expect(await client.claim()).toBeNull();
	});

	it("a replaced lease throws TurnBoxLeaseLost on every write; a stop throws ApiTurnCancelled", async () => {
		const { client, edge } = await setup();
		const session = await client.claim();
		edge.row.lease_id = "66666666-6666-4666-8666-666666666666";
		await expect(session?.checkpoint([], [])).rejects.toBeInstanceOf(
			TurnBoxLeaseLost,
		);
		await expect(session?.renew()).rejects.toBeInstanceOf(TurnBoxLeaseLost);
		edge.row.lease_id =
			edge.queue[0]?.lease_id ?? "33333333-3333-4333-8333-333333333333";
		const second = await setup();
		const turn = await second.client.claim();
		second.edge.row.cancel_requested = true;
		await expect(turn?.checkpoint([], [])).rejects.toBeInstanceOf(
			ApiTurnCancelled,
		);
	});

	it("budget refusals surface as errors", async () => {
		const { client, edge } = await setup();
		const session = await client.claim();
		edge.state.reserveOk = false;
		await expect(session?.reserve(10)).rejects.toThrow(/safety budget/);
	});

	it("points the model SDK at the proxy with the grant as its key", async () => {
		const { client } = await setup();
		const session = await client.claim();
		const model = session?.modelEndpoint();
		expect(model?.baseUrl).toBe("https://edge.test/box/v1/model");
		expect(model?.apiKey()).toBe(session?.grant);
	});

	it("40 streaming steps: Worker requests and Durable Object requests per turn (measured, see docs)", async () => {
		vi.useFakeTimers();
		try {
			const { client, edge, requests, sockets, tick, counted } = await setup();
			const session = await client.claim();
			if (!session) throw new Error("no turn");
			expect(await session.openSocket()).toBe(true);
			const stops = vi.fn();
			session.onCancel = stops;
			const adapters = session.adapters();
			const httpAtStart = requests.length;
			const fetchModel = (base: string, grant: string) =>
				counted(`${base}/chat/completions`, {
					method: "POST",
					headers: { authorization: `Bearer ${grant}`, "content-length": "20" },
					body: "{}",
				});
			for (let step = 0; step < 40; step++) {
				// A step streams ~25 progress updates over ~5 s, then checkpoints.
				for (let update = 0; update < 25; update++) {
					await adapters.publishApiTurnProgress(null, [
						{ id: `s${step}u${update}` } as never,
					]);
					tick(200);
					await vi.advanceTimersByTimeAsync(200);
				}
				await adapters.checkpointApiTurn(
					null,
					[],
					[{ id: `s${step}` } as never],
				);
				// The step's second checkpoint (tool results) and its model request.
				await adapters.checkpointApiTurn(
					null,
					[],
					[{ id: `s${step}t` } as never],
				);
				await fetchModel(session.modelEndpoint().baseUrl, session.grant);
				if (step % 3 === 0) await adapters.renewApiTurn();
			}
			await vi.advanceTimersByTimeAsync(1_000);
			const http = requests.length - httpAtStart;
			const socketMessages = sockets.flatMap((s) => s.sent).length;
			// Per step: model request + 2 checkpoints (after the model, after the
			// tools) = 3 Worker requests; progress and renewals are socket messages.
			expect(http).toBe(40 * 3);
			// 1 socket upgrade = 1 DO request; messages bill 1/20.
			const doRequests = 1 + Math.ceil(socketMessages / 20);
			// MISSES the ~100 / ~10 targets (120 and ~19 for steps that stream
			// 5 s each); pinned here so a regression shows. See the docs.
			expect(http).toBeGreaterThan(TURN_BOX_REQUEST_BUDGET.workerRequests);
			expect(doRequests).toBeLessThanOrEqual(20);
			// Coalescing: 1000 updates became at most 1 message per 500 ms (~10 000 ms*... ).
			const progress = sockets
				.flatMap((s) => s.sent)
				.filter((m) => m.includes('"progress"'));
			expect(progress.length).toBeLessThanOrEqual(
				Math.ceil((40 * 5_000) / 500) + 2,
			);
			expect(progress.length).toBeLessThan(1000 / 2);
			expect(edge.row.items.length).toBeGreaterThan(0);
			expect(stops).not.toHaveBeenCalled();
			console.info("turn-box budget sample", {
				http,
				socketMessages,
				doRequests,
				progress: progress.length,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("Stop pushed over the socket reaches the box without an HTTP call", async () => {
		const { client, sockets } = await setup();
		const session = await client.claim();
		if (!session) throw new Error("no turn");
		await session.openSocket();
		const stops = vi.fn();
		session.onCancel = stops;
		for (const handler of sockets[0]?.received ?? [])
			handler(JSON.stringify({ t: "cancel" }));
		expect(stops).toHaveBeenCalledOnce();
		expect(await session.renew()).toBe("cancel");
		expect(await session.cancelRequested()).toBe(true);
	});

	it("falls back to HTTP progress when no socket can open", async () => {
		const edge = await fakeEdge();
		edge.queue.push({ ...edge.row });
		const requests: string[] = [];
		const client = new TurnBoxEdgeClient({
			edgeUrl: "https://edge.test",
			identity: edge.identity,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new URL(String(input)).pathname);
				return edge.fetchEdge(input, init);
			}) as typeof fetch,
			now: () => edge.state.now,
			socket: async () => {
				throw new Error("no socket");
			},
		});
		const session = await client.claim();
		expect(await session?.openSocket()).toBe(false);
		session?.publishProgress([{ id: "p" } as never]);
		await vi.waitFor(() => expect(requests).toContain("/box/v1/progress"));
		await vi.waitFor(() => expect(edge.row.items).toEqual([{ id: "p" }]));
	});
});
