import { describe, expect, it } from "vitest";
import {
	issueTurnBoxGrant,
	TURN_BOX_IDENTITY_REFRESH_MS,
	TURN_BOX_IDENTITY_TTL_MS,
	verifyTurnBoxIdentity,
} from "../../domain/turn-box-grant";
import {
	TURN_BOX_HANDOFF_HISTORY_BYTES,
	TURN_BOX_MAX_HISTORY_BYTES,
	TURN_BOX_PATHS,
} from "../../domain/turn-box-protocol";
import { FAKE_TURN, fakeEdge } from "./turn-box-fake-edge";
import {
	forgetLatestBoxVersionForTests,
	turnBoxEdgeConfig,
} from "./turn-box-routes";
import { answerTurnBoxSocketMessage } from "./turn-box-socket";

describe("runner identity renewal", () => {
	it("returns a non-cacheable replacement for the same box only when requested", async () => {
		const edge = await fakeEdge();
		edge.state.now += TURN_BOX_IDENTITY_TTL_MS - TURN_BOX_IDENTITY_REFRESH_MS;
		const body = { capacity: 4, running: 1 };
		const legacy = await post(
			edge,
			TURN_BOX_PATHS.register,
			edge.identity,
			body,
		);
		expect(await legacy.json()).toEqual({ ok: true });
		const renewed = await post(edge, TURN_BOX_PATHS.register, edge.identity, {
			...body,
			refreshIdentity: true,
		});
		expect(renewed.status).toBe(200);
		expect(renewed.headers.get("cache-control")).toBe("no-store");
		const { identity } = await renewed.json();
		const verified = await verifyTurnBoxIdentity(
			edge.keys.publicKey,
			identity,
			edge.state.now,
		);
		expect(verified).toMatchObject({
			boxId: "box-a",
			expiresAt: edge.state.now + TURN_BOX_IDENTITY_TTL_MS,
		});
	});

	it("refuses renewal if the identity expires during registration", async () => {
		const edge = await fakeEdge();
		edge.state.now += TURN_BOX_IDENTITY_TTL_MS - 1;
		edge.ops.register = async () => {
			edge.state.now += 1;
			return true;
		};
		const response = await post(edge, TURN_BOX_PATHS.register, edge.identity, {
			capacity: 1,
			running: 0,
			refreshIdentity: true,
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});
});

const grantFor = async (
	edge: Awaited<ReturnType<typeof fakeEdge>>,
	over: Partial<{
		userId: string;
		sessionId: string;
		turnId: string;
		leaseId: string;
		boxId: string;
	}> = {},
) =>
	issueTurnBoxGrant(
		edge.keys.privateKey,
		{
			userId: FAKE_TURN.user_id,
			sessionId: FAKE_TURN.session_id,
			turnId: FAKE_TURN.id,
			leaseId: FAKE_TURN.lease_id,
			boxId: "box-a",
			...over,
		},
		edge.state.now,
	);
const post = (
	edge: Awaited<ReturnType<typeof fakeEdge>>,
	path: string,
	token: string,
	body: unknown = {},
) =>
	edge.fetchEdge(`https://edge.test${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"content-length": String(JSON.stringify(body).length),
		},
		body: JSON.stringify(body),
	});

type Body = {
	renewed?: boolean;
	grant?: string;
	version?: string;
	messages?: unknown[];
	turn?: { id: string };
};
const asBody = async (response: Response) => (await response.json()) as Body;

const WRITES: [string, string, unknown][] = [
	["renew", TURN_BOX_PATHS.renew, {}],
	["checkpoint", TURN_BOX_PATHS.checkpoint, { messages: [], items: [] }],
	["progress", TURN_BOX_PATHS.progress, { items: [] }],
	["finalize", TURN_BOX_PATHS.finalize, { state: "completed", items: [] }],
	["history", TURN_BOX_PATHS.history, {}],
	["reserve", TURN_BOX_PATHS.reserve, { tokens: 100 }],
	["cancel", TURN_BOX_PATHS.cancel, {}],
];

describe("turn box edge: lease and user checks", () => {
	for (const [name, path, body] of WRITES) {
		it(`${name} refuses a stale lease and a wrong user, and writes nothing`, async () => {
			const edge = await fakeEdge();
			const stale = await grantFor(edge, {
				leaseId: "44444444-4444-4444-8444-444444444444",
			});
			expect((await post(edge, path, stale, body)).status).toBe(409);
			const stranger = await grantFor(edge, { userId: "user-2" });
			expect((await post(edge, path, stranger, body)).status).toBe(409);
			const otherChat = await grantFor(edge, {
				sessionId: "55555555-5555-4555-8555-555555555555",
			});
			expect((await post(edge, path, otherChat, body)).status).toBe(409);
			expect(
				edge.calls.filter((call) => !["loadOwned"].includes(call)),
			).toEqual([]);
			expect((await post(edge, path, "ytbg1.forged.sig", body)).status).toBe(
				401,
			);
			// A grant past its expiry is a forged one.
			const old = await grantFor(edge);
			edge.state.now += 11 * 60 * 1000;
			expect((await post(edge, path, old, body)).status).toBe(401);
		});
	}

	it("a zombie box whose lease was taken over is fenced at the write, even holding a valid grant", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		// Another box took the turn over between the load and the write.
		const loaded = { ...edge.row };
		edge.ops.loadOwned = async () => loaded;
		edge.row.lease_id = "66666666-6666-4666-8666-666666666666";
		const response = await post(edge, TURN_BOX_PATHS.checkpoint, grant, {
			messages: [{ role: "user", content: "x" }],
			items: [{ id: "i" }],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ ok: false, reason: "lease-lost" });
		expect(edge.row.items).toEqual([]);
	});

	it("a stopped turn answers cancelled to writes and cancel-check", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		edge.row.cancel_requested = true;
		const checkpoint = await post(edge, TURN_BOX_PATHS.checkpoint, grant, {
			messages: [],
			items: [],
		});
		expect(await checkpoint.json()).toEqual({ ok: false, reason: "cancelled" });
		expect(
			await (await post(edge, TURN_BOX_PATHS.cancel, grant)).json(),
		).toEqual({ cancelRequested: true });
		const renewed = await (
			await post(edge, TURN_BOX_PATHS.renew, grant)
		).json();
		expect(renewed).toMatchObject({ renewed: false, cancelRequested: true });
	});

	it("a successful write lands, and finalize reports the effective state", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		expect(
			(
				await post(edge, TURN_BOX_PATHS.checkpoint, grant, {
					messages: [{ role: "user", content: "hi" }],
					items: [{ id: "a" }],
				})
			).status,
		).toBe(200);
		expect(edge.row.items).toEqual([{ id: "a" }]);
		const done = await (
			await post(edge, TURN_BOX_PATHS.finalize, grant, {
				state: "completed",
				items: [{ id: "a" }],
			})
		).json();
		expect(done).toEqual({ ok: true, state: "completed" });
		// Finished: the same grant now finds no running turn.
		expect(
			(await post(edge, TURN_BOX_PATHS.progress, grant, { items: [] })).status,
		).toBe(409);
	});

	it("renew refreshes a grant past half its life once, never on replay", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		edge.state.now += 6 * 60 * 1000;
		const first = await asBody(await post(edge, TURN_BOX_PATHS.renew, grant));
		expect(first.renewed).toBe(true);
		expect(first.grant).toMatch(/^ytbg1\./);
		const replayed = await asBody(
			await post(edge, TURN_BOX_PATHS.renew, grant),
		);
		expect(replayed.renewed).toBe(true);
		expect(replayed.grant).toBeUndefined();
	});

	it("history is versioned, compressed and bounded", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		edge.row.messages = [{ role: "user", content: "hello" }] as never;
		const response = await post(edge, TURN_BOX_PATHS.history, grant);
		expect(response.headers.get("x-was-gzip")).toBe("1");
		const body = await asBody(response);
		expect(body.messages).toHaveLength(1);
		const cached = await (
			await post(edge, TURN_BOX_PATHS.history, grant, { version: body.version })
		).json();
		expect(cached).toEqual({ notModified: true, version: body.version });
		edge.row.messages = [
			{ role: "user", content: "x".repeat(TURN_BOX_MAX_HISTORY_BYTES + 1) },
		] as never;
		expect((await post(edge, TURN_BOX_PATHS.history, grant)).status).toBe(413);
	});

	it("reserve passes a refusal through as 429", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		edge.state.reserveOk = false;
		const response = await post(edge, TURN_BOX_PATHS.reserve, grant, {
			tokens: 5,
		});
		expect(response.status).toBe(429);
	});

	it("is off without users, and 503 without keys", () => {
		expect(turnBoxEdgeConfig({}, "")).toEqual({ status: 404 });
		expect(turnBoxEdgeConfig({}, "user-1")).toEqual({ status: 503 });
		expect(
			turnBoxEdgeConfig(
				{
					TURN_BOX_EDGE_PRIVATE_KEY: "k".repeat(44),
					TURN_BOX_EDGE_PUBLIC_KEY: "p".repeat(44),
				},
				"user-1",
			).status,
		).toBe(200);
	});
});

describe("turn box edge: claim and identity", () => {
	const claim = (
		edge: Awaited<ReturnType<typeof fakeEdge>>,
		nonce = "abcdef0123456789",
		token?: string,
	) =>
		edge.fetchEdge("https://edge.test/box/v1/claim", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token ?? edge.identity}`,
				"x-ytimesy-nonce": nonce,
				"x-ytimesy-ts": String(edge.state.now),
			},
			body: "{}",
		});

	it("hands a queued turn and its grant to an authenticated box, once per nonce", async () => {
		const edge = await fakeEdge();
		edge.queue.push({ ...edge.row });
		const response = await claim(edge);
		expect(response.status).toBe(200);
		const body = await asBody(response);
		expect(body.turn?.id).toBe(FAKE_TURN.id);
		expect(body.grant).toMatch(/^ytbg1\./);
		expect(JSON.stringify(body)).not.toMatch(/sk-real|postgres/);
		expect((await claim(edge)).status).toBe(401);
		expect((await claim(edge, "0123456789abcdef")).status).toBe(204);
	});

	it("holds an empty claim open as a long poll: a turn queued during the wait is handed over, an empty wait answers 204", async () => {
		const longPoll = (
			edge: Awaited<ReturnType<typeof fakeEdge>>,
			nonce: string,
		) =>
			edge.fetchEdge("https://edge.test/box/v1/claim", {
				method: "POST",
				headers: {
					authorization: `Bearer ${edge.identity}`,
					"x-ytimesy-nonce": nonce,
					"x-ytimesy-ts": String(edge.state.now),
				},
				body: JSON.stringify({ waitMs: 20_000 }),
			});
		const edge = await fakeEdge();
		let pauses = 0;
		(edge.deps as { sleep?: unknown }).sleep = async () => {
			pauses += 1;
			// A turn is queued while the box's claim waits.
			if (pauses === 3) edge.queue.push({ ...edge.row });
		};
		const found = await longPoll(edge, "1111111111111111");
		expect(found.status).toBe(200);
		expect((await asBody(found)).turn?.id).toBe(FAKE_TURN.id);
		expect(pauses).toBe(3);
		// Nothing queued: it looks every 2 s for the 20 s, then answers 204.
		pauses = 0;
		(edge.deps as { sleep?: unknown }).sleep = async () => {
			pauses += 1;
		};
		expect((await longPoll(edge, "2222222222222222")).status).toBe(204);
		expect(pauses).toBe(10);
	});

	it("refuses a forged identity, a stale timestamp and a revoked box", async () => {
		const edge = await fakeEdge();
		expect((await claim(edge, "aaaaaaaaaaaaaaaa", "ytbi1.x.y")).status).toBe(
			401,
		);
		// A grant is not an identity.
		expect(
			(await claim(edge, "bbbbbbbbbbbbbbbb", await grantFor(edge))).status,
		).toBe(401);
		const late = await edge.fetchEdge("https://edge.test/box/v1/claim", {
			method: "POST",
			headers: {
				authorization: `Bearer ${edge.identity}`,
				"x-ytimesy-nonce": "cccccccccccccccc",
				"x-ytimesy-ts": String(edge.state.now - 5 * 60_000),
			},
			body: "{}",
		});
		expect(late.status).toBe(401);
		edge.state.revoked = true;
		expect((await claim(edge, "dddddddddddddddd")).status).toBe(403);
		const register = await edge.fetchEdge("https://edge.test/box/v1/register", {
			method: "POST",
			headers: { authorization: `Bearer ${edge.identity}` },
			body: JSON.stringify({ capacity: 2, running: 0 }),
		});
		expect(register.status).toBe(403);
	});

	it("tells a registering box which program is published, so an old one upgrades itself", async () => {
		forgetLatestBoxVersionForTests();
		const edge = await fakeEdge({
			bundle: async () => ({
				url: "https://r2.test/turn-box/b.mjs.gz?sig",
				sha256: "b".repeat(64),
				version: "b-version",
			}),
		});
		const response = await post(edge, TURN_BOX_PATHS.register, edge.identity, {
			capacity: 1,
			running: 0,
			version: "a-version",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			latestVersion: "b-version",
		});
		forgetLatestBoxVersionForTests();
	});

	it("serves the box program to a live identity only", async () => {
		const bundle = {
			url: "https://r2.test/turn-box/a.mjs.gz?sig",
			sha256: "a".repeat(64),
			version: "a",
		};
		const edge = await fakeEdge({ bundle: async () => bundle });
		const url = "https://edge.test/box/v1/bundle";
		const get = (token: string | null) =>
			edge.fetchEdge(url, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
		expect((await get(null)).status).toBe(401);
		// A grant is not an identity.
		expect((await get(await grantFor(edge))).status).toBe(401);
		const served = await get(edge.identity);
		expect(served.status).toBe(200);
		expect(await served.json()).toEqual(bundle);
		expect(
			(await edge.fetchEdge(url, { method: "POST", headers: {} })).status,
		).toBe(405);
		edge.state.revoked = true;
		expect((await get(edge.identity)).status).toBe(403);
		const none = await fakeEdge();
		expect(
			(
				await none.fetchEdge(url, {
					headers: { authorization: `Bearer ${none.identity}` },
				})
			).status,
		).toBe(404);
	});

	it("releases a claimed turn of a user not enabled for boxes", async () => {
		const edge = await fakeEdge({ users: "someone-else" });
		edge.queue.push({ ...edge.row });
		expect((await claim(edge)).status).toBe(204);
		expect(edge.calls).toContain("release");
	});

	it("tells the chat's object a claimed turn started (Y² hears box turns)", async () => {
		const edge = await fakeEdge();
		edge.queue.push({ ...edge.row });
		expect((await claim(edge)).status).toBe(200);
		expect(edge.calls).toContain("noteStarted");
	});

	it("does not tell it of a turn handed back to the object (the object's loop does)", async () => {
		const edge = await fakeEdge();
		edge.row.messages = [
			{ role: "user", content: "x".repeat(TURN_BOX_HANDOFF_HISTORY_BYTES) },
		];
		edge.queue.push({ ...edge.row });
		await claim(edge);
		expect(edge.calls).not.toContain("noteStarted");
	});

	it("hands a turn with a history too long for a box to its chat's object", async () => {
		const edge = await fakeEdge();
		edge.row.messages = [
			{ role: "user", content: "x".repeat(TURN_BOX_HANDOFF_HISTORY_BYTES) },
		];
		edge.queue.push({ ...edge.row });
		expect((await claim(edge)).status).toBe(204);
		expect(edge.calls).toContain("handToObject");
	});

	it("revoking a box stops its renewals and model requests", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		edge.state.revoked = true;
		expect((await post(edge, TURN_BOX_PATHS.renew, grant)).status).toBe(403);
		const model = await post(
			edge,
			`${TURN_BOX_PATHS.model}/chat/completions`,
			grant,
			{ model: "m" },
		);
		expect(model.status).toBe(403);
	});

	it("serves the model proxy for API-key connections only", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		const okResponse = await post(
			edge,
			`${TURN_BOX_PATHS.model}/chat/completions`,
			grant,
			{ model: "m" },
		);
		expect(okResponse.status).toBe(200);
		edge.row.connection_kind = "subscription";
		expect(
			(await post(edge, `${TURN_BOX_PATHS.model}/chat/completions`, grant, {}))
				.status,
		).toBe(403);
	});

	it("only upgrades socket requests, and forwards verified grants", async () => {
		const edge = await fakeEdge();
		const grant = await grantFor(edge);
		expect((await post(edge, TURN_BOX_PATHS.socket, grant)).status).toBe(426);
		const upgrade = await edge.fetchEdge(
			`https://edge.test${TURN_BOX_PATHS.socket}`,
			{
				headers: { authorization: `Bearer ${grant}`, upgrade: "websocket" },
			},
		);
		expect(upgrade.status).toBe(204);
	});
});

describe("turn box socket (Durable Object side)", () => {
	const attachment = {
		boxId: "box-a",
		userId: FAKE_TURN.user_id,
		sessionId: FAKE_TURN.session_id,
		turnId: FAKE_TURN.id,
		leaseId: FAKE_TURN.lease_id,
	};

	it("acks progress and renewals under the lease, and tells a fenced box", async () => {
		const edge = await fakeEdge();
		const progress = await answerTurnBoxSocketMessage(
			attachment,
			JSON.stringify({ t: "progress", seq: 1, items: [{ id: "p" }] }),
			edge.ops,
		);
		expect(progress.reply).toEqual([{ t: "ack", seq: 1, ok: true }]);
		expect(edge.row.items).toEqual([{ id: "p" }]);
		const renew = await answerTurnBoxSocketMessage(
			attachment,
			JSON.stringify({ t: "renew", seq: 2 }),
			edge.ops,
		);
		expect(renew.reply).toEqual([{ t: "ack", seq: 2, ok: true }]);
		edge.row.cancel_requested = true;
		const stopped = await answerTurnBoxSocketMessage(
			attachment,
			JSON.stringify({ t: "progress", seq: 3, items: [] }),
			edge.ops,
		);
		expect(stopped.reply).toEqual([{ t: "cancel" }]);
		edge.row.cancel_requested = false;
		edge.row.lease_id = "66666666-6666-4666-8666-666666666666";
		const zombie = await answerTurnBoxSocketMessage(
			attachment,
			JSON.stringify({ t: "progress", seq: 4, items: [{ id: "z" }] }),
			edge.ops,
		);
		expect(zombie.reply).toEqual([{ t: "lease-lost" }]);
		expect(edge.row.items).toEqual([{ id: "p" }]);
	});

	it("refuses another user's attachment, binary and malformed messages", async () => {
		const edge = await fakeEdge();
		const wrong = await answerTurnBoxSocketMessage(
			{ ...attachment, userId: "user-2" },
			JSON.stringify({ t: "renew", seq: 1 }),
			edge.ops,
		);
		expect(wrong.reply).toEqual([{ t: "lease-lost" }]);
		expect(edge.calls).not.toContain("renew");
		for (const bad of [
			new ArrayBuffer(4),
			"not json",
			JSON.stringify({ t: "other" }),
		])
			expect(
				(await answerTurnBoxSocketMessage(attachment, bad, edge.ops)).close,
			).toBe(true);
		edge.state.revoked = true;
		const revoked = await answerTurnBoxSocketMessage(
			attachment,
			JSON.stringify({ t: "renew", seq: 1 }),
			edge.ops,
		);
		expect(revoked).toEqual({ reply: [{ t: "lease-lost" }], close: true });
	});
});

describe("EC2 enrollment", () => {
	const url = "https://edge.test/box/v1/enroll";
	const send = (
		edge: Awaited<ReturnType<typeof fakeEdge>>,
		headers: unknown = { x: 1 },
	) =>
		edge.fetchEdge(url, { method: "POST", body: JSON.stringify({ headers }) });

	it("is off (404) unless configured", async () => {
		expect((await send(await fakeEdge())).status).toBe(404);
	});

	it("gives an identity for the instance STS vouches for, and refuses the rest", async () => {
		let asked: string | null = "i-0123456789abcdef0";
		const edge = await fakeEdge({ enroll: async () => asked });
		const ok = await send(edge);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control")).toBe("no-store");
		const { identity } = (await ok.json()) as { identity: string };
		const verified = await verifyTurnBoxIdentity(
			edge.keys.publicKey,
			identity,
			edge.state.now,
		);
		expect(verified?.boxId).toBe("i-0123456789abcdef0");
		asked = null;
		expect((await send(edge)).status).toBe(401);
		asked = "i-0123456789abcdef0";
		edge.state.revoked = true;
		expect((await send(edge)).status).toBe(403);
	});
});
