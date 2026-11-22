import { describe, expect, it, vi } from "vitest";
import { boxPortOps, TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { fakeEdge } from "../edge/turn-box-fake-edge";
import { TurnBoxEdgeClient, TurnBoxLeaseLost } from "./turn-box-client";
import { BOX_PORTS_UNAVAILABLE, boxTurnPorts } from "./turn-box-ports";
import { TurnPortUnavailable } from "./turn-ports";
import { localTurnPorts } from "./turn-ports-local";

const USER = "user-1";
const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";

async function setup() {
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
			throw new Error("no socket in this test");
		},
	});
	const session = await client.claim();
	if (!session) throw new Error("no turn claimed");
	const ports = boxTurnPorts(session);
	/** What the edge saw for `op`: the args after validation. */
	const served = (op: string, result: unknown = null) => {
		const seen = vi.fn((_args: unknown) => undefined);
		(edge.state.ports as Record<string, unknown>)[op] = (args: unknown) => {
			seen(args);
			return result;
		};
		return seen;
	};
	return { edge, client, session, ports, requests, served };
}

describe("boxTurnPorts over the edge's port endpoint", () => {
	it("serves each read and write through one lease-checked endpoint, never sending the user or turn", async () => {
		const { ports, served, requests } = await setup();
		const cases: [string, () => Promise<unknown>, unknown, unknown][] = [
			[
				"sessionMetadata",
				() => ports.agentSessionMetadataForOwner(USER, SESSION),
				{ sessionId: SESSION },
				{ id: SESSION },
			],
			[
				"sessionAncestors",
				() => ports.subagentAncestors(USER, SESSION),
				{},
				[],
			],
			[
				"importedSessions",
				() => ports.projectImportedSessions(USER, "p1"),
				{ projectId: "p1" },
				[],
			],
			[
				"projectYMode",
				() => ports.projectYMode(USER, "p1"),
				{ projectId: "p1" },
				null,
			],
			[
				"modelConnection",
				() => ports.loadModelConnection(USER, "conn-1"),
				{ id: "conn-1" },
				{ id: "conn-1" },
			],
			[
				"lifecycleContinuations",
				() => ports.completedLifecycleContinuations(SESSION, TURN),
				{},
				2,
			],
			[
				"conversationPointCodeRef",
				() => ports.conversationPointCodeRef(USER, SESSION, "m1"),
				{ messageId: "m1" },
				"ref-1",
			],
			[
				"verificationBaseline",
				() => ports.readVerificationBaseline(USER, SESSION, "/work"),
				{ directory: "/work" },
				{ sha: "a" },
			],
			[
				"preparedCheckoutDirectory",
				() => ports.readPreparedCheckoutDirectory(USER, SESSION, null),
				{ projectId: null },
				"/work/x",
			],
			[
				"savePreparedCheckoutDirectory",
				() => ports.savePreparedCheckoutDirectory(USER, SESSION, "/work/x"),
				{ directory: "/work/x" },
				null,
			],
			[
				"projectDerivedValue",
				() => ports.readProjectDerivedValue(USER, "p1", "k"),
				{ projectId: "p1", key: "k" },
				{ v: 1 },
			],
			[
				"sessionDerivedValue",
				() => ports.readSessionDerivedValue(USER, SESSION, "k"),
				{ key: "k" },
				{ v: 2 },
			],
			[
				"saveSessionDerivedValue",
				() => ports.saveSessionDerivedValue(USER, SESSION, "k", { v: 3 }),
				{ key: "k", value: { v: 3 } },
				null,
			],
			[
				"pluginSkillIndex",
				() => ports.enabledPluginSkillIndex(USER, "p1"),
				{ projectId: "p1" },
				[],
			],
			[
				"pluginSkillBody",
				() => ports.pluginSkillBody(USER, "i1", "s1"),
				{ installId: "i1", skill: "s1" },
				{ body: "b" },
			],
			[
				"harnessVariant",
				() => ports.harnessVariantForUser(USER),
				{},
				{ lead: "x" },
			],
			["isDevEvalUser", () => ports.isDevEvalUser(USER), {}, false],
			[
				"otherRunningTurnOnMachine",
				() => ports.otherRunningTurnOnMachine(USER, TURN, "vm-1"),
				{ vm: "vm-1" },
				true,
			],
			[
				"saveTaskResult",
				() =>
					ports.saveAgentTaskResultAndEvent({
						sessionId: SESSION,
						summary: "done",
						turnId: TURN,
						eventType: "completed",
					}),
				{ summary: "done", eventType: "completed" },
				"event-1",
			],
			[
				"enqueueTaskEvent",
				() => ports.enqueueAgentTaskEvent("e1"),
				{ eventId: "e1" },
				null,
			],
			[
				"archiveContext",
				() =>
					ports.archiveModelContext(USER, SESSION, [
						{ role: "user", content: "x" },
					]),
				{ messages: [{ role: "user", content: "x" }] },
				"context-1",
			],
			[
				"writeSecretsToVm",
				() =>
					ports.writeAgentProjectSecrets(
						{} as never,
						"vm" as never,
						{} as never,
					),
				{},
				null,
			],
			[
				"ensureCodePoint",
				() =>
					ports.ensureConversationCodePoint(USER, SESSION, "m1", {
						cwd: "/work/x",
					} as never),
				{ messageId: "m1", cwd: "/work/x" },
				null,
			],
			["codexAuth", () => ports.hasManagedCodexAuth(USER), {}, true],
			[
				"commitTurn",
				() => ports.commitSessionTurn({} as never, []),
				{ items: [] },
				null,
			],
			[
				"coordinateTurn",
				() =>
					ports.coordinateConversationTurn("acquire", {
						userId: USER,
						sessionId: SESSION,
						turnId: TURN,
						leaseId: "l",
					}),
				{ action: "acquire" },
				true,
			],
		];
		for (const [op, run, args, result] of cases) {
			const seen = served(op, result);
			const before = requests.length;
			const got = await run();
			expect(seen, op).toHaveBeenCalledWith(args);
			// One request per port call, to the one endpoint.
			expect(requests.slice(before), op).toEqual(["/box/v1/port"]);
			if (op === "conversationPointCodeRef") expect(got).toBe("ref-1");
			else if (result !== null) expect(got, op).toEqual(result);
		}
		// Every op the protocol lists has a box member and a case above (or is batched below).
		const covered = new Set(cases.map(([op]) => op));
		expect(
			boxPortOps.filter(
				(op) =>
					!covered.has(op) &&
					![
						// Asked with the turn's model settings: box-subscription-turn-e2e.test.ts.
						"codexSelection",
						"analytics",
						"userHubNote",
						"crewWaiting",
						"peerInboxRead",
						"peerInboxAccept",
						"projectSecretNames",
						// The edge does these itself at finalize (the box's ports are no-ops).
						"releaseHeldTaskEvents",
						"cloudProjectReport",
						// Helper operations: turn-box-subagent-port.test.ts and box-turn-e2e.test.ts.
						"subagent",
						// MCP: turn-box-mcp-port.test.ts and box-turn-e2e.test.ts.
						"mcpListing",
						"mcpCall",
						// Memory: turn-box-memory-port.test.ts and box-turn-e2e.test.ts.
						"memory",
						// Tools the edge runs whole: turn-box-tool-port.test.ts and box-turn-e2e.test.ts.
						"remoteTool",
						"pushNotices",
						"commandReceipt",
						"canvasRevision",
						// Plain git on the VM: turn-box-machine-git-port.test.ts.
						"machineGit",
						// Y² and helpers: turn-box-y-squared-port.test.ts, turn-box-helper-port.test.ts, box-turn-e2e.test.ts.
						"ySquared",
						"helperStep",
						"helperMemory",
						// Failover: box-turn-e2e.test.ts ("model failover on a box").
						"planFailover",
					].includes(op),
			),
		).toEqual([]);
	});

	it("asks each read that is fixed for a turn once, and the post-settle work not at all", async () => {
		const { ports, session, requests, served } = await setup();
		served("sessionMetadata", { id: SESSION });
		served("projectYMode", { enabled: false });
		served("modelConnection", { id: "c1" });
		const before = requests.length;
		for (let step = 0; step < 5; step++) {
			await ports.agentSessionMetadataForOwner(USER, SESSION);
			await ports.projectYMode(USER, "p1");
			await ports.loadModelConnection(USER, "c1");
			await ports.modelAccess?.loadConnection(USER, "c1");
		}
		expect(requests.length - before).toBe(3);
		// Settled work is the edge's: no request from the box.
		const settled = requests.length;
		expect(await ports.releaseHeldAgentTaskEvents(SESSION)).toBe(0);
		expect(await ports.startQueuedUserTurn({} as never, USER, SESSION)).toBe(
			false,
		);
		expect(await ports.replaceSettledTurnItem({} as never, "i", null)).toBe(
			false,
		);
		await ports.recordCloudProjectReport({} as never, TURN, []);
		expect(requests.length).toBe(settled);
		expect(session.publishAfterFinalize).toBe(false);
	});

	it("a commit that left a push pending makes the box's finalize ask the edge to publish", async () => {
		const { ports, session, served } = await setup();
		served("commitTurn", { notice: "n", publish: true });
		const committed = await ports.commitSessionTurn({} as never, []);
		expect(committed?.notice).toBe("n");
		expect(session.publishAfterFinalize).toBe(true);
		// The push is the edge's: the box's publish does nothing and fails nothing.
		await expect(committed?.publish?.()).resolves.toEqual({});
	});

	it("rejects a stale lease on every op, before any data is returned", async () => {
		const { edge, session } = await setup();
		for (const op of boxPortOps)
			(edge.state.ports as Record<string, unknown>)[op] = () => "SECRET-ROW";
		// Another box took the turn over: the grant's lease is no longer the row's.
		edge.row.lease_id = "99999999-9999-4999-8999-999999999999";
		const args: Record<string, unknown> = {
			sessionMetadata: { sessionId: SESSION },
			importedSessions: { projectId: "p" },
			projectYMode: { projectId: "p" },
			modelConnection: { id: "c" },
			conversationPointCodeRef: { messageId: "m" },
			verificationBaseline: { directory: "/" },
			preparedCheckoutDirectory: { projectId: null },
			projectDerivedValue: { projectId: "p", key: "k" },
			sessionDerivedValue: { key: "k" },
			pluginSkillIndex: { projectId: null },
			pluginSkillBody: { installId: "i", skill: "s" },
			otherRunningTurnOnMachine: { vm: "v" },
			savePreparedCheckoutDirectory: { directory: "/" },
			saveSessionDerivedValue: { key: "k", value: 1 },
			archiveContext: { messages: [] },
			cloudProjectReport: { items: [] },
			saveTaskResult: { summary: "s", eventType: "failed" },
			enqueueTaskEvent: {},
			analytics: {
				events: [
					{
						event: "turn_started",
						properties: {},
						identity: { key: "k", timestamp: 1 },
					},
				],
			},
			userHubNote: { topics: ["t"] },
			crewWaiting: { projectId: "p", ySquaredId: null, waitingOn: "question" },
			peerInboxAccept: { ids: ["a"] },
			coordinateTurn: { action: "renew" },
		};
		for (const op of boxPortOps)
			await expect(
				session.port(op, (args[op] ?? {}) as never),
				op,
			).rejects.toBeInstanceOf(TurnBoxLeaseLost);
		// None of the edge's handlers ran.
		expect(edge.calls.filter((call) => call.startsWith("port:"))).toEqual([]);
	});

	it("rejects a grant whose user is not the turn's user (wrong user)", async () => {
		const { edge, session, served } = await setup();
		const seen = served("sessionAncestors", ["row"]);
		// The row now belongs to someone else: the grant names user-1.
		edge.row.user_id = "someone-else";
		await expect(session.port("sessionAncestors", {})).rejects.toBeInstanceOf(
			TurnBoxLeaseLost,
		);
		expect(seen).not.toHaveBeenCalled();
	});

	it("refuses a call that names another user or chat on the box, without a request", async () => {
		const { ports, requests } = await setup();
		const before = requests.length;
		await expect(
			ports.agentSessionMetadataForOwner("victim", SESSION),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		await expect(
			ports.readSessionDerivedValue(
				USER,
				"33333333-3333-4333-8333-333333333333",
				"k",
			),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		await expect(
			ports.completedLifecycleContinuations(SESSION, "another-turn"),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		expect(requests.length).toBe(before);
	});

	it("answers an op with no edge handler as unavailable, and a bad argument as a failure", async () => {
		const { session, edge } = await setup();
		await expect(session.port("harnessVariant", {})).rejects.toBeInstanceOf(
			TurnPortUnavailable,
		);
		await expect(
			session.port("analytics", { events: [] } as never),
		).rejects.toThrow(/failed \(400\)/);
		// An op that is not in the protocol never reaches a handler.
		const response = await edge.fetchEdge("https://edge.test/box/v1/port", {
			method: "POST",
			headers: {
				authorization: `Bearer ${session.grant}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ op: "dropTable", args: {} }),
		});
		expect(response.status).toBe(400);
	});

	it("refuses a revoked box's port calls", async () => {
		const { edge, session, served } = await setup();
		const seen = served("harnessVariant", {});
		edge.state.revoked = true;
		await expect(session.port("harnessVariant", {})).rejects.toBeInstanceOf(
			TurnBoxPortForbidden,
		);
		expect(seen).not.toHaveBeenCalled();
	});

	it("keeps ports with no edge endpoint explicit: they throw, listed", async () => {
		const { ports, requests } = await setup();
		const before = requests.length;
		for (const name of BOX_PORTS_UNAVAILABLE) {
			if (name === "gitPushRequests") {
				expect(() => ports.gitPushRequests.latestRefused({} as never)).toThrow(
					TurnPortUnavailable,
				);
				continue;
			}
			expect(() => (ports[name] as () => unknown)(), name).toThrow(
				TurnPortUnavailable,
			);
		}
		expect(requests.length).toBe(before);
	});

	it("has the same members as the Durable Object's local ports", async () => {
		const { ports } = await setup();
		const members = (value: object) =>
			Object.keys(value)
				.filter((key) => key !== "modelAccess" && key !== "flush")
				.sort();
		expect(members(ports)).toEqual(members(localTurnPorts));
	});

	it("serves project secret NAMES only, never a value, env file or redaction list", async () => {
		const { ports, served } = await setup();
		const seen = served("projectSecretNames", {
			names: [{ name: "STRIPE_KEY", kind: "runtime" }],
			// A faulty edge that leaked values is not trusted either.
			envFile: "STRIPE_KEY=sk_live_abc",
			redact: ["sk_live_abc"],
		});
		const secrets = await ports.loadAgentProjectSecrets(USER, "p1");
		expect(seen).toHaveBeenCalledWith({});
		expect(secrets.names).toEqual([{ name: "STRIPE_KEY", kind: "runtime" }]);
		expect(secrets.redact).toEqual([]);
		expect(JSON.stringify(secrets)).not.toContain("sk_live");
	});

	it("batches analytics into one request, sent on flush", async () => {
		const { ports, served, requests } = await setup();
		const seen = served("analytics");
		const before = requests.length;
		for (let index = 0; index < 3; index++)
			await ports.captureServerAnalytics(
				USER,
				"harness_tool_completed",
				{} as never,
				{ key: `k${index}`, timestamp: new Date(5_000) },
			);
		expect(requests.length).toBe(before);
		await ports.flush();
		expect(requests.slice(before)).toEqual(["/box/v1/port"]);
		const [first] = seen.mock.calls;
		const events =
			(first?.[0] as { events: unknown[] } | undefined)?.events ?? [];
		expect(events).toHaveLength(3);
		expect(events[0]).toMatchObject({
			event: "harness_tool_completed",
			identity: { key: "k0", timestamp: 5_000 },
		});
	});

	it("reads the inbox, saves the history, and only then accepts the rows", async () => {
		const { ports, served, edge } = await setup();
		const rows = [
			{ id: "r1", message: "hello from a peer", queued_send: null },
			{ id: "setup-catch-up:x", message: "ready", queued_send: null },
		];
		served("peerInboxRead", rows);
		const accepted = served("peerInboxAccept");
		const order: string[] = [];
		let catchUp = false;
		const history = [{ role: "user" as const, content: "first" }];
		const result = await ports.injectServerPeerMessages(
			SESSION,
			history,
			async (messages) => {
				order.push(`checkpoint:${messages.length}`);
				expect(accepted).not.toHaveBeenCalled();
			},
			() => false,
			() => {
				catchUp = true;
			},
		);
		expect(result).toEqual([
			...history,
			{ role: "user", content: "hello from a peer" },
		]);
		expect(order).toEqual(["checkpoint:2"]);
		expect(accepted).toHaveBeenCalledWith({ ids: ["r1"] });
		// The setup catch-up row is reported, never injected or accepted.
		expect(catchUp).toBe(true);
		expect(edge.calls.filter((call) => call.startsWith("port:"))).toEqual([
			"port:peerInboxRead",
			"port:peerInboxAccept",
		]);
		// An empty inbox is one read and no accept.
		served("peerInboxRead", []);
		await expect(
			ports.injectServerPeerMessages(SESSION, history, async () => undefined),
		).resolves.toBe(history);
	});

	it("points the model SDK at the edge proxy with a placeholder key and the grant-injecting fetch", async () => {
		const { ports, session } = await setup();
		expect(ports.modelAccess?.baseUrl).toBe("https://edge.test/box/v1/model");
		expect(ports.modelAccess?.apiKey).not.toBe(session.grant);
		expect(JSON.stringify(ports.modelAccess)).not.toContain(session.grant);
	});
});
