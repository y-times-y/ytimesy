import { describe, expect, it } from "vitest";
import {
	boxTurnBlock,
	boxTurnUsers,
	chooseTurnExecutor,
	localTurnsEnabled,
} from "./turn-executor";

describe("chooseTurnExecutor", () => {
	const base = {
		configured: "durable-object" as const,
		userId: "alice",
		boxUsers: boxTurnUsers("alice, bob"),
		eligible: true,
		boxAlive: true,
	};

	it("sends an enabled user's API turn to a box that was seen lately", () => {
		expect(chooseTurnExecutor(base)).toBe("node");
		expect(chooseTurnExecutor({ ...base, boxUsers: boxTurnUsers("*") })).toBe(
			"node",
		);
	});

	it("keeps the turn in its chat's Durable Object otherwise", () => {
		// No box seen lately: a down fleet never strands a turn.
		expect(chooseTurnExecutor({ ...base, boxAlive: false })).toBe(
			"durable-object",
		);
		// Not enabled, or a subscription or Claude turn.
		expect(chooseTurnExecutor({ ...base, userId: "mallory" })).toBe(
			"durable-object",
		);
		expect(chooseTurnExecutor({ ...base, eligible: false })).toBe(
			"durable-object",
		);
		expect(
			chooseTurnExecutor({ ...base, boxUsers: boxTurnUsers(undefined) }),
		).toBe("durable-object");
	});

	it("never changes a deployment that runs turns on the node executor", () => {
		expect(chooseTurnExecutor({ ...base, configured: "node" })).toBe("node");
	});
});

it("runs turns locally only on a development server that asked for it", () => {
	const development = {
		YTIMESY_ENVIRONMENT: "development",
		NODE_ENV: "development",
	};
	expect(localTurnsEnabled({ ...development, YTIMESY_LOCAL_TURNS: "1" })).toBe(
		true,
	);
	expect(localTurnsEnabled(development)).toBe(false);
	expect(
		localTurnsEnabled({ ...development, YTIMESY_LOCAL_TURNS: "true" }),
	).toBe(false);
	// Production, or a deployment that forgot its environment, never does.
	expect(
		localTurnsEnabled({
			...development,
			NODE_ENV: "production",
			YTIMESY_LOCAL_TURNS: "1",
		}),
	).toBe(false);
	expect(localTurnsEnabled({ YTIMESY_LOCAL_TURNS: "1" })).toBe(false);
});

describe("boxTurnBlock (what keeps a turn off the boxes)", () => {
	const none = { subagent: false, evaluation: false, hasRuntimeSecrets: false };
	it("lets a plain root chat's turn run on a box", () => {
		expect(boxTurnBlock(none, {})).toBeNull();
	});
	it("keeps helper chats and evaluation runs in their Durable Objects", () => {
		expect(boxTurnBlock({ ...none, subagent: true }, {})).toBe("subagent");
		expect(boxTurnBlock({ ...none, evaluation: true }, {})).toBe("evaluation");
	});
	it("keeps a project with runtime secrets off the box unless the secrets flag is 1", () => {
		const secrets = { ...none, hasRuntimeSecrets: true };
		expect(boxTurnBlock(secrets, {})).toBe("runtime-secrets");
		expect(
			boxTurnBlock(secrets, { YTIMESY_CLAUDE_BOX_TOOLS_SECRETS: "0" }),
		).toBe("runtime-secrets");
		expect(
			boxTurnBlock(secrets, { YTIMESY_CLAUDE_BOX_TOOLS_SECRETS: "1" }),
		).toBeNull();
		// The flag never lifts the other blocks.
		expect(
			boxTurnBlock(
				{ ...secrets, subagent: true },
				{ YTIMESY_CLAUDE_BOX_TOOLS_SECRETS: "1" },
			),
		).toBe("subagent");
	});
});

describe("turn box routing: Y² and the turn-box secrets switch", () => {
	const none = { subagent: false, evaluation: false, hasRuntimeSecrets: false };
	it("keeps lead mode fusion off the boxes", () => {
		expect(boxTurnBlock({ ...none, leadFusion: true }, {})).toBe("lead-fusion");
	});
	it("keeps a Y² chat off the boxes", () => {
		// Y² runs on a box: its tools go through the edge.
		expect(boxTurnBlock({ ...none, ySquared: true }, {})).toBeNull();
	});
	it("lets runtime-secret chats on with YTIMESY_TURN_BOX_SECRETS=1 alone", () => {
		const secrets = { ...none, hasRuntimeSecrets: true };
		expect(boxTurnBlock(secrets, { YTIMESY_TURN_BOX_SECRETS: "1" })).toBeNull();
		expect(boxTurnBlock(secrets, { YTIMESY_TURN_BOX_SECRETS: "0" })).toBe(
			"runtime-secrets",
		);
	});
});
