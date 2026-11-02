import { describe, expect, it } from "vitest";
import {
	apiModelFailureMessage,
	ClaudeCodeRunFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "./api-turn-failure";
import {
	CLAUDE_CODE_KEY,
	claudeCodeListedModels,
	claudeCodeTurnRevision,
	claudeSubscriptionEnabled,
	parseClaudeCodeRouteId,
} from "./claude-code-route";
import { composerSendIsEnabled } from "./harness-access";
import {
	type FailoverConnection,
	failoverCandidates,
	failoverNotice,
	routeConnectionKey,
	routeKey,
} from "./model-failover";
import {
	failoverReason,
	subscriptionLimitResetsAt,
} from "./model-failover-reason";

const claudeRoute = {
	connectionId: null,
	connectionRevision: claudeCodeTurnRevision(),
	modelId: "claude-opus-5-5",
};
const connections: FailoverConnection[] = [
	{
		key: CLAUDE_CODE_KEY,
		label: "Claude Code",
		kind: "subscription",
		revision: "",
		models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
	},
	{
		key: "33333333-3333-4333-8333-333333333333",
		label: "Anthropic",
		kind: "key",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		revision: "r1",
		models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
	},
];

describe("Claude Code routes", () => {
	it("are their own connection, apart from the Codex plan", () => {
		expect(routeConnectionKey(claudeRoute)).toBe("claude-code");
		expect(routeKey(claudeRoute)).toBe("claude-code|claude-opus-5-5");
		expect(
			routeConnectionKey({
				connectionId: null,
				connectionRevision: 'codex-subscription:v1:{"fast":false}',
			}),
		).toBe("codex");
	});

	it("parse only the models a Claude plan covers", () => {
		expect(parseClaudeCodeRouteId("claude-code/claude-opus-5-5")).toBe(
			"claude-opus-5-5",
		);
		expect(parseClaudeCodeRouteId("claude-code/gpt-6.1-sol")).toBeNull();
		expect(parseClaudeCodeRouteId("api/x/claude-opus-5-5")).toBeNull();
		expect(claudeCodeListedModels().map((model) => model.id)).toEqual([
			"claude-code/claude-opus-5-5",
			"claude-code/claude-sonnet-5-5",
			"claude-code/claude-haiku-5-5",
		]);
	});

	it("fail over to the same model on an API key", () => {
		const [first] = failoverCandidates({
			original: claudeRoute,
			connections,
			tried: [routeKey(claudeRoute)],
		});
		expect(first).toMatchObject({
			route: {
				connectionId: "33333333-3333-4333-8333-333333333333",
				modelId: "claude-opus-5-5",
			},
			sameModel: true,
			paid: true,
		});
	});

	it("can be the fallback of another route", () => {
		const [first] = failoverCandidates({
			original: {
				connectionId: "33333333-3333-4333-8333-333333333333",
				connectionRevision: "r1",
				modelId: "claude-opus-5-5",
			},
			connections,
			tried: ["33333333-3333-4333-8333-333333333333|claude-opus-5-5"],
		});
		expect(first?.route).toEqual(claudeRoute);
		expect(first?.paid).toBe(false);
	});

	it("classify a spent plan and a refused token for failover", () => {
		const reset = new Date(1_900_000_000_000);
		expect(failoverReason(new ClaudeSubscriptionLimitReached(reset))).toBe(
			"usage-limit",
		);
		expect(
			subscriptionLimitResetsAt(new ClaudeSubscriptionLimitReached(reset)),
		).toBe(1_900_000_000_000);
		expect(failoverReason(new ClaudeSubscriptionRefused())).toBe("signed-out");
		expect(failoverReason(new ClaudeCodeRunFailure("x."))).toBeNull();
		expect(apiModelFailureMessage(new ClaudeSubscriptionRefused())).toMatch(
			/claude setup-token/,
		);
		expect(
			failoverNotice(
				{ model: "Claude Opus 5.5", connection: "Claude Code" },
				{ model: "Claude Opus 5.5", connection: "Anthropic" },
				"usage-limit",
			),
		).toBe(
			"Your Claude plan's usage is used up, so this chat continued on Claude Opus 5.5 via Anthropic.",
		);
		expect(
			failoverNotice(
				{ model: "Claude Opus 5.5", connection: "Claude Code" },
				{ model: "Claude Opus 5.5", connection: "Anthropic" },
				"signed-out",
			),
		).toMatch(/^Anthropic refused your Claude token/);
	});

	it("are off unless the switch is on", () => {
		expect(claudeSubscriptionEnabled({})).toBe(false);
		expect(
			claudeSubscriptionEnabled({ YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED: "1" }),
		).toBe(true);
	});
});

describe("Claude Code in the composer", () => {
	it("can send on a Claude Code model", () => {
		const base = {
			harnessId: "api" as const,
			connection: { status: "disconnected" as const },
			turnStatus: "idle" as const,
			canSend: true,
			busy: false,
			draft: "hello",
			slashDraft: false,
		};
		expect(
			composerSendIsEnabled({
				...base,
				modelId: "claude-code/claude-opus-5-5",
			}),
		).toBe(true);
		expect(
			composerSendIsEnabled({ ...base, modelId: "claude-code/other" }),
		).toBe(false);
	});
});
