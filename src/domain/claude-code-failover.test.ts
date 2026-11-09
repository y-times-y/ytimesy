import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
	apiModelFailureMessage,
	ClaudeCodeApiUnavailable,
	ClaudeCodeRunFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
	SafeApiModelFailure,
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
	decideFailover,
	type FailoverConnection,
	failoverCandidates,
	failoverNotice,
	MAX_FALLBACK_HOPS,
	nextTurnFailover,
	routeConnectionKey,
	routeKey,
	turnFailover,
} from "./model-failover";
import {
	failoverReason,
	fallbackAccountReason,
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
		label: "Claude Agent",
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
			"claude-code/claude-fable-5-2",
			"claude-code/claude-fable-5-1",
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
				{ model: "Claude Opus 5.5", connection: "Claude Agent" },
				{ model: "Claude Opus 5.5", connection: "Anthropic" },
				"usage-limit",
			),
		).toBe(
			"Your Claude plan's usage is used up, so this chat continued on Claude Opus 5.5 via Anthropic.",
		);
		expect(
			failoverNotice(
				{ model: "Claude Opus 5.5", connection: "Claude Agent" },
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

describe("the 2026-11-02 live failover", () => {
	// Claude Code's token refused; connected: the ChatGPT plan (Codex),
	// SuperGrok, and an OpenRouter key with almost no credit.
	const OPENROUTER = "11111111-1111-4111-8111-111111111111";
	const SUPERGROK = "00000000-0000-4000-8000-0000000000a1";
	const live: FailoverConnection[] = [
		{
			key: OPENROUTER,
			label: "OpenRouter",
			kind: "gateway",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			revision: "or-rev",
			models: [
				{ id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5" },
				{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
			],
		},
		{
			key: SUPERGROK,
			label: "SuperGrok",
			kind: "plan",
			provider: "compatible",
			baseUrl: "https://api.x.ai/v1",
			revision: "sg-rev",
			models: [{ id: "grok-4.7", label: "Grok 4.7" }],
		},
		{
			key: "codex",
			label: "Codex",
			kind: "subscription",
			revision: "",
			models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }],
		},
		connections[0] as FailoverConnection,
	];
	const outOfCredit = new SafeApiModelFailure(
		new APICallError({
			message: "Payment Required",
			url: "https://openrouter.ai/api/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 402,
			responseBody:
				'{"error":{"message":"This request requires more credits. You requested up to 64000 tokens, but can only afford 1253.","code":402}}',
		}),
	);

	it("continues on the user's other subscriptions before a paid key, even for the same model", () => {
		const candidates = failoverCandidates({
			original: claudeRoute,
			connections: live,
			tried: [routeKey(claudeRoute)],
			excludedConnections: [CLAUDE_CODE_KEY],
		});
		expect(
			candidates.map((row) => [row.connectionLabel, row.modelLabel, row.paid]),
		).toEqual([
			["Codex", "GPT-6.1 Sol", false],
			["SuperGrok", "Grok 4.7", false],
			["OpenRouter", "Claude Opus 5.5", true],
			["OpenRouter", "GPT-6.1 Sol", true],
		]);
	});

	it("follows a saved connection order one connection at a time", () => {
		const candidates = failoverCandidates({
			original: claudeRoute,
			connections: live,
			order: [OPENROUTER, "codex"],
			tried: [routeKey(claudeRoute)],
		});
		expect(
			candidates.map((row) => `${row.modelLabel} via ${row.connectionLabel}`),
		).toEqual([
			"Claude Opus 5.5 via OpenRouter",
			"GPT-6.1 Sol via OpenRouter",
			"GPT-6.1 Sol via Codex",
			"Grok 4.7 via SuperGrok",
		]);
	});

	it("moves past a fallback that is out of credit, never back onto its connection", () => {
		// The chosen route itself never moves for its own account problem.
		expect(failoverReason(outOfCredit)).toBeNull();
		expect(fallbackAccountReason(outOfCredit)).toBe("out-of-credit");
		const toOpenRouter = failoverCandidates({
			original: claudeRoute,
			connections: live,
			order: [OPENROUTER, "codex"],
			tried: [routeKey(claudeRoute)],
		})[0];
		if (!toOpenRouter) throw new Error("No candidate.");
		const first = nextTurnFailover(
			null,
			{
				route: claudeRoute,
				label: { model: "Claude Opus 5.5", connection: "Claude Agent" },
			},
			toOpenRouter,
			"signed-out",
		);
		expect(first.excluded).toEqual([CLAUDE_CODE_KEY]);
		expect(first.fallbackHops).toBeUndefined();
		const stored = turnFailover(JSON.parse(JSON.stringify(first)));
		const [next] = failoverCandidates({
			original: claudeRoute,
			connections: live,
			order: [OPENROUTER, "codex"],
			tried: stored?.tried ?? [],
			excludedConnections: [...(stored?.excluded ?? []), OPENROUTER],
		});
		expect(next).toMatchObject({ connectionLabel: "Codex", paid: false });
		if (!next || !stored) throw new Error("No candidate.");
		const second = nextTurnFailover(
			stored,
			{ route: stored.route, label: stored.label },
			next,
			"out-of-credit",
		);
		expect(second).toMatchObject({
			switches: 2,
			fallbackHops: 1,
			excluded: [CLAUDE_CODE_KEY, OPENROUTER],
		});
		expect(failoverNotice(stored.label, second.label, "out-of-credit")).toBe(
			"OpenRouter is out of credit, so this chat continued on GPT-6.1 Sol via Codex.",
		);
		expect(
			decideFailover({
				policy: "any-model",
				switches: 1,
				serving: stored.route,
				candidates: [next],
				askBeforePaid: false,
				canAsk: true,
				reason: "out-of-credit",
				fallbackHops: MAX_FALLBACK_HOPS,
			}).kind,
		).toBe("stop");
	});

	it("moves on from Claude Code's own API errors when Anthropic is down", () => {
		for (const reason of ["outage", "overloaded", "rate-limited"] as const) {
			expect(failoverReason(new ClaudeCodeApiUnavailable(reason))).toBe(reason);
			expect(
				apiModelFailureMessage(new ClaudeCodeApiUnavailable(reason)),
			).toMatch(/^Anthropic /);
		}
	});
});
