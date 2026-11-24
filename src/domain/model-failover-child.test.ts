import { expect, it } from "vitest";
import { ClaudeSubscriptionLimitReached } from "./api-turn-failure";
import {
	CLAUDE_CODE_KEY,
	CLAUDE_CODE_LABEL,
	CLAUDE_CODE_MODELS,
	claudeCodeTurnRevision,
} from "./claude-code-route";
import {
	chosenRoute,
	decideFailover,
	excludedFailoverConnections,
	type FailoverConnection,
	failoverCandidates,
	routeKey,
	turnFailoverPolicy,
} from "./model-failover";
import { failoverReason } from "./model-failover-reason";

// 2026-11-22 00:45: Claude Opus writer helpers on the user's Claude plan,
// which was used up; the user's Grok plan kept serving their root chat.
const original = chosenRoute({
	connection_id: null,
	connection_revision: claudeCodeTurnRevision(),
	model_id: "claude-opus-5-5",
});
const connections: FailoverConnection[] = [
	{
		key: CLAUDE_CODE_KEY,
		label: CLAUDE_CODE_LABEL,
		kind: "subscription",
		revision: "",
		models: CLAUDE_CODE_MODELS.map(({ id, label }) => ({ id, label })),
	},
	{
		key: "grok-plan",
		label: "SuperGrok",
		kind: "plan",
		provider: "compatible",
		baseUrl: "https://api.x.ai/v1",
		revision: "r1",
		models: [
			{ id: "grok-4.7", label: "Grok 4.7" },
			{ id: "grok-4.6", label: "Grok 4.6" },
		],
	},
];

function childDecision(reason: NonNullable<ReturnType<typeof failoverReason>>) {
	const policy = turnFailoverPolicy({
		enabled: true,
		evaluation: false,
		child: true,
		reason,
	});
	return decideFailover({
		policy,
		switches: 0,
		serving: original,
		candidates: failoverCandidates({
			original,
			connections,
			tried: [routeKey(original)],
			excludedConnections: excludedFailoverConnections(null, original, reason),
			sameModelOnly: policy === "same-model",
		}),
		askBeforePaid: true,
		canAsk: false,
		servingPrepaid: true,
		reason,
	});
}

it("moves a helper off a spent Claude plan to the closest model the user can still run", () => {
	const reason = failoverReason(
		new ClaudeSubscriptionLimitReached(new Date(Date.now() + 45 * 60_000)),
	);
	expect(reason).toBe("usage-limit");
	const decision = childDecision("usage-limit");
	expect(decision.kind).toBe("switch");
	if (decision.kind === "switch")
		expect(decision.candidate.route).toMatchObject({
			connectionId: "grok-plan",
			modelId: "grok-4.7",
		});
});

it("keeps a helper on its model through a brief failure", () => {
	expect(childDecision("overloaded").kind).toBe("stop");
	expect(childDecision("rate-limited").kind).toBe("stop");
});

it("still prefers the helper's own model on another connection when one serves it", () => {
	const policy = turnFailoverPolicy({
		enabled: true,
		evaluation: false,
		child: true,
		reason: "usage-limit",
	});
	expect(policy).toBe("same-model-first");
	const same = {
		route: { connectionId: "or", connectionRevision: "r", modelId: "x" },
		connectionKey: "or",
		connectionLabel: "OpenRouter",
		modelLabel: "Claude Opus 5.5",
		paid: false,
		sameModel: true,
	};
	const closest = { ...same, connectionKey: "grok", sameModel: false };
	expect(
		decideFailover({
			policy,
			switches: 0,
			serving: original,
			candidates: [closest, same],
			askBeforePaid: false,
			canAsk: false,
		}),
	).toEqual({ kind: "switch", candidate: same });
});
