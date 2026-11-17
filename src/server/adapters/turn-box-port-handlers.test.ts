import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import type { ApiTurn } from "./api-turns";

const mocks = vi.hoisted(() => ({
	agentSessionMetadataForOwner: vi.fn(),
	loadModelConnection: vi.fn(),
	loadAgentProjectSecrets: vi.fn(),
	readProjectDerivedValue: vi.fn(),
	readSessionDerivedValue: vi.fn(),
	acceptPeerInbox: vi.fn(),
	readPeerInbox: vi.fn(),
	captureServerAnalytics: vi.fn(async () => undefined),
	noteCrewWaiting: vi.fn(),
}));
vi.mock("./y-squared-crew-client", () => ({
	noteCrewWaiting: mocks.noteCrewWaiting,
}));
vi.mock("./agent-sessions", () => ({
	agentSessionMetadataForOwner: mocks.agentSessionMetadataForOwner,
}));
vi.mock("./model-connections", () => ({
	loadModelConnection: mocks.loadModelConnection,
}));
vi.mock("../services/project-secrets", () => ({
	loadAgentProjectSecrets: mocks.loadAgentProjectSecrets,
}));
vi.mock("./prepared-checkout", () => ({
	readPreparedCheckoutDirectory: vi.fn(),
	readProjectDerivedValue: mocks.readProjectDerivedValue,
	readSessionDerivedValue: mocks.readSessionDerivedValue,
	savePreparedCheckoutDirectory: vi.fn(),
	saveSessionDerivedValue: vi.fn(),
}));
vi.mock("./server-peer-inbox", () => ({
	acceptPeerInbox: mocks.acceptPeerInbox,
	readPeerInbox: mocks.readPeerInbox,
}));
vi.mock("./analytics", () => ({
	captureServerAnalytics: mocks.captureServerAnalytics,
}));

import { turnBoxPort } from "./turn-box-port-handlers";

const turn = {
	id: "22222222-2222-4222-8222-222222222222",
	session_id: "11111111-1111-4111-8111-111111111111",
	user_id: "user-1",
	lease_id: "33333333-3333-4333-8333-333333333333",
} as ApiTurn;

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.agentSessionMetadataForOwner.mockResolvedValue({
		id: turn.session_id,
		projectId: "p1",
		parentSessionId: "44444444-4444-4444-8444-444444444444",
	});
});

describe("the edge's turn port handlers", () => {
	it("sends a box turn's waiting card to the crew with the user and chat from the turn row", async () => {
		await turnBoxPort(turn, "crewWaiting", {
			projectId: "p1",
			ySquaredId: "y2",
			waitingOn: "secret",
		});
		expect(mocks.noteCrewWaiting).toHaveBeenCalledWith({
			sessionId: turn.session_id,
			userId: turn.user_id,
			projectId: "p1",
			ySquaredId: "y2",
			waitingOn: "secret",
		});
		await expect(
			turnBoxPort(turn, "crewWaiting", {
				projectId: "other",
				ySquaredId: null,
				waitingOn: "secret",
			}),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		expect(mocks.noteCrewWaiting).toHaveBeenCalledTimes(1);
	});

	it("takes the user and chat from the turn row, never from the call", async () => {
		mocks.readSessionDerivedValue.mockResolvedValue({ v: 1 });
		const done = await turnBoxPort(turn, "sessionDerivedValue", { key: "k" });
		expect(done).toEqual({ served: true, result: { v: 1 } });
		expect(mocks.readSessionDerivedValue).toHaveBeenCalledWith(
			"user-1",
			turn.session_id,
			"k",
		);
	});

	it("refuses another chat, and serves only the parent chat's metadata", async () => {
		await expect(
			turnBoxPort(turn, "sessionMetadata", {
				sessionId: "55555555-5555-4555-8555-555555555555",
			}),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		await turnBoxPort(turn, "sessionMetadata", {
			sessionId: "44444444-4444-4444-8444-444444444444",
		});
		expect(mocks.agentSessionMetadataForOwner).toHaveBeenLastCalledWith(
			"user-1",
			"44444444-4444-4444-8444-444444444444",
		);
	});

	it("refuses another project's data (project ids are checked against the chat's)", async () => {
		await expect(
			turnBoxPort(turn, "projectDerivedValue", {
				projectId: "other",
				key: "k",
			}),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		expect(mocks.readProjectDerivedValue).not.toHaveBeenCalled();
		await turnBoxPort(turn, "projectDerivedValue", {
			projectId: "p1",
			key: "k",
		});
		expect(mocks.readProjectDerivedValue).toHaveBeenCalledWith(
			"user-1",
			"p1",
			"k",
		);
	});

	it("serves a connection without its sealed credential", async () => {
		mocks.loadModelConnection.mockResolvedValue({
			id: "c1",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			sealedCredential: "SEALED-KEY",
		});
		const done = await turnBoxPort(turn, "modelConnection", { id: "c1" });
		expect(done).toMatchObject({ served: true });
		expect(JSON.stringify(done)).not.toContain("SEALED-KEY");
		expect(mocks.loadModelConnection).toHaveBeenCalledWith("user-1", "c1");
	});

	it("serves project secret names only, from the chat's own project", async () => {
		mocks.loadAgentProjectSecrets.mockResolvedValue({
			envFile: "STRIPE=sk_live_1",
			redact: ["sk_live_1"],
			names: [{ name: "STRIPE", kind: "runtime" }],
		});
		const done = await turnBoxPort(turn, "projectSecretNames", {});
		expect(done).toEqual({
			served: true,
			result: { names: [{ name: "STRIPE", kind: "runtime" }] },
		});
		expect(JSON.stringify(done)).not.toContain("sk_live_1");
		expect(mocks.loadAgentProjectSecrets).toHaveBeenCalledWith("user-1", "p1");
	});

	it("reads and accepts only the turn's own chat's inbox", async () => {
		mocks.readPeerInbox.mockResolvedValue([]);
		await turnBoxPort(turn, "peerInboxRead", {});
		await turnBoxPort(turn, "peerInboxAccept", { ids: ["a"] });
		expect(mocks.readPeerInbox).toHaveBeenCalledWith(turn.session_id);
		expect(mocks.acceptPeerInbox).toHaveBeenCalledWith(turn.session_id, ["a"]);
	});

	it("records batched analytics for the turn's user", async () => {
		await turnBoxPort(turn, "analytics", {
			events: [
				{
					event: "turn_started",
					properties: {},
					identity: { key: "k", timestamp: 5_000 },
				},
			],
		} as never);
		expect(mocks.captureServerAnalytics).toHaveBeenCalledWith(
			"user-1",
			"turn_started",
			{},
			{ key: "k", timestamp: new Date(5_000), setOnce: undefined },
		);
	});
});
