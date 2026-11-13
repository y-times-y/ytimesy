import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { API_MODEL_LIST } from "./api-model-list";
import {
	ApiModelPreparationFailure,
	ApiTurnCancelled,
	CodexEgressUnavailable,
	CodexReconnectRequired,
	IncompleteAgentTurn,
	SafeApiModelFailure,
	SubscriptionMetadataFailure,
	SubscriptionUsageLimitReached,
	XaiSubscriptionUnavailable,
} from "./api-turn-failure";
import {
	canonicalModelId,
	chosenRoute,
	decideFailover,
	type FailoverConnection,
	failoverCandidates,
	failoverChainFailure,
	failoverConnectionKind,
	failoverExhaustedDetail,
	failoverNotice,
	forcedDevelopmentOutage,
	MAX_TURN_FAILOVERS,
	MODEL_STEP_RETRY_DELAYS_MS,
	MODEL_TIERS,
	type ModelRoute,
	modelTier,
	nextTurnFailover,
	orderedFailoverConnections,
	routeKey,
	routeRetries,
	SUBSCRIPTION_MODEL_EQUIVALENTS,
	servingRoute,
	turnFailover,
	turnFailoverPolicy,
	withRouteRetries,
} from "./model-failover";
import {
	failoverReason,
	failureSummary,
	fallbackAccountReason,
	retriesSameRoute,
} from "./model-failover-reason";
import { ProjectSecretsPreparationFailure } from "./project-secret";
import {
	subscriptionTurnRevision,
	subscriptionTurnSettings,
} from "./subscription-turn";

const apiError = (
	statusCode: number | undefined,
	data?: unknown,
	isRetryable = statusCode === undefined || statusCode >= 500,
	responseBody?: string,
) =>
	new APICallError({
		message: `HTTP ${statusCode}`,
		url: "https://provider.invalid/v1/responses",
		requestBodyValues: {},
		statusCode,
		data,
		isRetryable,
		responseBody,
	});

describe("failoverReason", () => {
	it.each([
		[
			"a 503 behind the safe wrapper",
			new SafeApiModelFailure(apiError(503)),
			"outage",
		],
		[
			"a 500 after the SDK's retries",
			new SafeApiModelFailure(
				new RetryError({
					message: "Failed after 5 attempts",
					reason: "maxRetriesExceeded",
					errors: [apiError(500)],
				}),
			),
			"outage",
		],
		["an overloaded 529", new SafeApiModelFailure(apiError(529)), "overloaded"],
		[
			"an overloaded 503 body",
			apiError(503, undefined, true, '{"error":{"type":"overloaded_error"}}'),
			"overloaded",
		],
		[
			"a streamed overloaded_error",
			new SafeApiModelFailure({
				type: "error",
				error: { type: "overloaded_error", message: "Overloaded" },
			}),
			"overloaded",
		],
		[
			"a temporary 429",
			new SafeApiModelFailure(
				apiError(429, { error: { code: "rate_limit_exceeded" } }, true),
			),
			"rate-limited",
		],
		["a gateway timeout", new SafeApiModelFailure(apiError(504)), "timeout"],
		[
			"a connection failure",
			new SafeApiModelFailure(apiError(undefined)),
			"outage",
		],
		[
			"a dropped stream",
			new SafeApiModelFailure(
				Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			),
			"outage",
		],
		[
			"a request timeout",
			new SafeApiModelFailure(new DOMException("timed out", "TimeoutError")),
			"timeout",
		],
		[
			"a spent ChatGPT plan",
			new SafeApiModelFailure(new SubscriptionUsageLimitReached(null)),
			"usage-limit",
		],
		[
			"an unreachable Codex catalog",
			new SubscriptionMetadataFailure("transport"),
			"outage",
		],
		["a Codex catalog 502", new SubscriptionMetadataFailure(502), "outage"],
		[
			"a stream that ended in error",
			new IncompleteAgentTurn("error"),
			"outage",
		],
	] as const)("moves on %s", (_name, error, reason) => {
		expect(failoverReason(error)).toBe(reason);
	});

	it.each([
		[
			"an invalid request",
			new SafeApiModelFailure(
				apiError(400, { error: { code: "invalid_request_error" } }),
			),
		],
		[
			"a context window overflow",
			new SafeApiModelFailure(
				apiError(400, { error: { code: "context_length_exceeded" } }),
			),
		],
		["a too-large request", new SafeApiModelFailure(apiError(413))],
		["a rejected key", new SafeApiModelFailure(apiError(401))],
		["a forbidden model", new SafeApiModelFailure(apiError(403))],
		[
			"a permanent quota (429)",
			new SafeApiModelFailure(
				apiError(429, { error: { code: "insufficient_quota" } }, false),
			),
		],
		[
			"a content refusal",
			new SafeApiModelFailure(
				apiError(400, { error: { code: "content_filter" } }),
			),
		],
		["a content-filter finish", new IncompleteAgentTurn("content-filter")],
		["the step limit", new IncompleteAgentTurn("tool-calls")],
		[
			"a Codex reconnect",
			new SafeApiModelFailure(new CodexReconnectRequired()),
		],
		[
			"a wrapped Codex reconnect",
			Object.assign(new Error("wrapped"), {
				cause: new CodexReconnectRequired(),
			}),
		],
		["a user Stop", new ApiTurnCancelled()],
		[
			"a local preparation failure",
			new ApiModelPreparationFailure("credential"),
		],
		[
			"a Codex access challenge",
			new SubscriptionMetadataFailure("access-challenge"),
		],
		["an unknown error", new Error("something odd")],
	] as const)("never moves on %s", (_name, error) => {
		expect(failoverReason(error)).toBeNull();
	});

	it("finds a typed usage limit even when an SDK wrapper calls it retryable", () => {
		const wrapped = Object.assign(apiError(undefined), {
			cause: new SubscriptionUsageLimitReached(null),
		});
		expect(failoverReason(wrapped)).toBe("usage-limit");
	});
});

const OPENROUTER = "11111111-1111-4111-8111-111111111111";
const OPENAI_KEY = "22222222-2222-4222-8222-222222222222";
const ANTHROPIC_KEY = "33333333-3333-4333-8333-333333333333";
const CUSTOM = "44444444-4444-4444-8444-444444444444";

const codex: FailoverConnection = {
	key: "codex",
	label: "Codex",
	kind: "subscription",
	revision: "",
	models: [
		{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", reasoning: ["low", "high"] },
		{ id: "gpt-6-luna", label: "GPT-6-Luna" },
	],
};
const openRouter: FailoverConnection = {
	key: OPENROUTER,
	label: "OpenRouter",
	kind: "gateway",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	revision: "or-rev",
	models: [
		{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: ["high"] },
		{ id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5" },
		{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" },
	],
};
const openAiKey: FailoverConnection = {
	key: OPENAI_KEY,
	label: "OpenAI",
	kind: "key",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	revision: "oa-rev",
	models: [
		{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
		{ id: "gpt-6-astra", label: "GPT-6 Astra" },
	],
};
const anthropicKey: FailoverConnection = {
	key: ANTHROPIC_KEY,
	label: "Anthropic",
	kind: "key",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1",
	revision: "an-rev",
	models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
};
const custom: FailoverConnection = {
	key: CUSTOM,
	label: "Company gateway",
	kind: "custom",
	provider: "compatible",
	baseUrl: "https://gateway.example.com/v1",
	revision: "cu-rev",
	models: [{ id: "openai/gpt-6.1-sol", label: "openai/gpt-6.1-sol" }],
};
const all = [openRouter, custom, anthropicKey, openAiKey, codex];

const codexSol: ModelRoute = {
	connectionId: null,
	connectionRevision: subscriptionTurnRevision("high", false),
	modelId: "gpt-6.1-sol",
};

describe("model equivalence", () => {
	it("maps one model across Codex, direct keys, OpenRouter and custom endpoints", () => {
		expect(canonicalModelId(codex, "gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
		expect(canonicalModelId(openAiKey, "gpt-6.1-sol")).toBe(
			"openai/gpt-6.1-sol",
		);
		expect(canonicalModelId(openRouter, "openai/gpt-6.1-sol")).toBe(
			"openai/gpt-6.1-sol",
		);
		expect(canonicalModelId(custom, "openai/gpt-6.1-sol")).toBe(
			"openai/gpt-6.1-sol",
		);
		expect(canonicalModelId(anthropicKey, "claude-opus-5-5")).toBe(
			"anthropic/claude-opus-5.5",
		);
	});

	it("never matches by similarity", () => {
		expect(canonicalModelId(codex, "gpt-6.1-sol-pro")).toBeNull();
		expect(canonicalModelId(openAiKey, "claude-opus-5-5")).toBeNull();
		expect(canonicalModelId(openRouter, "openai/gpt-6.1")).toBeNull();
	});

	it("lists only real, listed models in its tables", () => {
		const listed = new Set(API_MODEL_LIST.map((entry) => entry.openRouterId));
		for (const id of Object.values(SUBSCRIPTION_MODEL_EQUIVALENTS))
			expect(listed.has(id)).toBe(true);
		const tiered = Object.values(MODEL_TIERS).flat();
		for (const id of tiered) expect(listed.has(id)).toBe(true);
		expect(new Set(tiered).size).toBe(tiered.length);
		expect(modelTier("anthropic/claude-opus-5.5")).toBe("frontier");
		expect(modelTier("meta/muse-wonder")).toBeNull();
	});
});

describe("candidate order", () => {
	it("puts subscriptions first, then keys, gateways and custom endpoints", () => {
		expect(orderedFailoverConnections(all).map((row) => row.key)).toEqual([
			"codex",
			ANTHROPIC_KEY,
			OPENAI_KEY,
			OPENROUTER,
			CUSTOM,
		]);
	});

	it("follows the user's order, then the default for unranked connections", () => {
		expect(
			orderedFailoverConnections(all, [OPENROUTER, "deleted"]).map(
				(row) => row.key,
			),
		).toEqual([OPENROUTER, "codex", ANTHROPIC_KEY, OPENAI_KEY, CUSTOM]);
	});

	it("tries the same model on other connections, then the closest same-tier model", () => {
		const candidates = failoverCandidates({
			original: codexSol,
			connections: all,
			tried: [routeKey(codexSol)],
		});
		expect(
			candidates.map((row) => [
				row.connectionLabel,
				row.modelLabel,
				row.sameModel,
			]),
		).toEqual([
			["OpenAI", "GPT-6.1 Sol", true],
			["OpenRouter", "GPT-6.1 Sol", true],
			["Company gateway", "openai/gpt-6.1-sol", true],
			// Same maker first, then the tier's order.
			["OpenAI", "GPT-6 Astra", false],
			["Anthropic", "Claude Opus 5.5", false],
			["OpenRouter", "Claude Opus 5.5", false],
		]);
		expect(candidates.every((row) => row.paid)).toBe(true);
	});

	it("keeps a supported reasoning level, never a faster paid speed", () => {
		const [openAi, viaOpenRouter] = failoverCandidates({
			original: { ...codexSol },
			connections: [openAiKey, openRouter],
			tried: [routeKey(codexSol)],
		});
		expect(openAi.route).toEqual({
			connectionId: OPENAI_KEY,
			connectionRevision: "oa-rev",
			modelId: "gpt-6.1-sol",
			settings: {},
		});
		expect(viaOpenRouter.route.settings).toEqual({ reasoning: "high" });
		const fromKey = failoverCandidates({
			original: {
				connectionId: OPENROUTER,
				connectionRevision: "or-rev",
				modelId: "openai/gpt-6.1-sol",
				settings: { reasoning: "high", speed: "fast" },
			},
			connections: all,
			tried: [`${OPENROUTER}|openai/gpt-6.1-sol`],
		});
		expect(fromKey[0]).toMatchObject({ connectionKey: "codex", paid: false });
		expect(
			subscriptionTurnSettings(fromKey[0].route.connectionRevision),
		).toEqual({ reasoning: "high", fast: false });
	});

	it("offers child agents the same model only, and skips custom endpoints on the edge", () => {
		const candidates = failoverCandidates({
			original: codexSol,
			connections: all,
			tried: [routeKey(codexSol)],
			sameModelOnly: true,
			allowCustom: false,
		});
		expect(candidates.map((row) => row.connectionLabel)).toEqual([
			"OpenAI",
			"OpenRouter",
		]);
	});

	it("never offers a route the turn already tried", () => {
		const tried = [
			routeKey(codexSol),
			`${OPENAI_KEY}|gpt-6.1-sol`,
			`${OPENROUTER}|openai/gpt-6.1-sol`,
		];
		const [first] = failoverCandidates({
			original: codexSol,
			connections: all,
			tried,
			allowCustom: false,
		});
		expect(first.modelLabel).toBe("GPT-6 Astra");
	});

	it("still maps the chosen model when its own catalog is down", () => {
		const candidates = failoverCandidates({
			original: codexSol,
			connections: [{ ...codex, models: [] }, openRouter],
			tried: [routeKey(codexSol)],
		});
		expect(candidates[0].route.modelId).toBe("openai/gpt-6.1-sol");
	});

	it("offers nothing for an unlisted model but the same id on its own connection", () => {
		expect(
			failoverCandidates({
				original: {
					connectionId: CUSTOM,
					connectionRevision: "cu-rev",
					modelId: "in-house-model",
				},
				connections: all,
				tried: [`${CUSTOM}|in-house-model`],
			}),
		).toEqual([]);
	});
});

describe("decisions and bounds", () => {
	const candidates = failoverCandidates({
		original: codexSol,
		connections: [codex, openRouter],
		tried: [routeKey(codexSol)],
	});

	it("switches automatically onto a paid key by default", () => {
		expect(
			decideFailover({
				policy: "any-model",
				switches: 0,
				serving: codexSol,
				candidates,
				askBeforePaid: false,
				canAsk: true,
			}),
		).toEqual({ kind: "switch", candidate: candidates[0] });
	});

	it("asks before leaving a subscription for a paid key when the user wants that", () => {
		const decision = decideFailover({
			policy: "any-model",
			switches: 0,
			serving: codexSol,
			candidates,
			askBeforePaid: true,
			canAsk: true,
		});
		expect(decision.kind).toBe("ask");
		// A child agent has nobody to ask: it stops instead of spending.
		expect(
			decideFailover({
				policy: "same-model",
				switches: 0,
				serving: codexSol,
				candidates,
				askBeforePaid: true,
				canAsk: false,
			}).kind,
		).toBe("stop");
		// Already on a paid key: moving between keys needs no new consent.
		expect(
			decideFailover({
				policy: "any-model",
				switches: 1,
				serving: candidates[0].route,
				candidates: candidates.slice(1),
				askBeforePaid: true,
				canAsk: true,
			}).kind,
		).toBe("switch");
	});

	it("stops after the maximum number of switches", () => {
		expect(
			decideFailover({
				policy: "any-model",
				switches: MAX_TURN_FAILOVERS,
				serving: codexSol,
				candidates,
				askBeforePaid: false,
				canAsk: true,
			}).kind,
		).toBe("stop");
	});

	it("keeps benchmarks and opted-out users pinned; children same-model only", () => {
		const base = {
			enabled: true,
			evaluation: false,
			child: false,
		};
		expect(turnFailoverPolicy(base)).toBe("any-model");
		expect(turnFailoverPolicy({ ...base, evaluation: true })).toBe("off");
		expect(turnFailoverPolicy({ ...base, enabled: false })).toBe("off");
		expect(turnFailoverPolicy({ ...base, child: true })).toBe("same-model");
		expect(
			decideFailover({
				policy: "same-model",
				switches: 0,
				serving: codexSol,
				candidates: candidates.filter((row) => !row.sameModel),
				askBeforePaid: false,
				canAsk: false,
			}).kind,
		).toBe("stop");
	});
});

describe("stickiness", () => {
	const turn = {
		connection_id: null,
		connection_revision: codexSol.connectionRevision,
		model_id: "gpt-6.1-sol",
		settings: {},
	};

	it("serves the rest of a failed-over turn from its fallback; the chosen route is unchanged", () => {
		const [candidate] = failoverCandidates({
			original: codexSol,
			connections: [openRouter],
			tried: [routeKey(codexSol)],
		});
		const failover = nextTurnFailover(
			null,
			{ route: codexSol, label: { model: "GPT-6.1-Sol", connection: "Codex" } },
			candidate,
		);
		const stored = JSON.parse(JSON.stringify(failover));
		expect(servingRoute({ ...turn, failover: stored })).toEqual(
			candidate.route,
		);
		expect(chosenRoute({ ...turn, failover: stored }).modelId).toBe(
			"gpt-6.1-sol",
		);
		expect(servingRoute({ ...turn, failover: null }).connectionId).toBeNull();
		expect(turnFailover({ route: "broken" })).toBeNull();
		expect(failover).toMatchObject({
			switches: 1,
			tried: [routeKey(codexSol), `${OPENROUTER}|openai/gpt-6.1-sol`],
		});
		expect(failoverNotice(failover.label, failover.label, "outage")).toContain(
			"is down right now",
		);
		expect(failoverExhaustedDetail(failover)).toBe(
			" Tried: GPT-6.1-Sol via Codex, GPT-6.1 Sol via OpenRouter.",
		);
	});

	it("words the notice with the connection that failed and the model that took over", () => {
		expect(
			failoverNotice(
				{ model: "GPT-6.1-Sol", connection: "Codex" },
				{ model: "GPT-6.1 Sol", connection: "OpenRouter" },
				"outage",
			),
		).toBe(
			"Codex is down right now, so this chat continued on GPT-6.1 Sol via OpenRouter.",
		);
		expect(
			failoverNotice(
				{ model: "GPT-6.1-Sol", connection: "Codex" },
				{ model: "GPT-6.1 Sol", connection: "OpenRouter" },
				"usage-limit",
			),
		).toBe(
			"Your ChatGPT plan's Codex usage is used up, so this chat continued on GPT-6.1 Sol via OpenRouter.",
		);
	});
});

describe("forced development outage", () => {
	it("applies only in development, to the named connection, from its step", () => {
		const env = {
			YTIMESY_DEV_FORCE_MODEL_OUTAGE: "codex@2",
			YTIMESY_ENVIRONMENT: "development",
		};
		expect(forcedDevelopmentOutage(env, "codex", 1)).toBe(false);
		expect(forcedDevelopmentOutage(env, "codex", 2)).toBe(true);
		expect(forcedDevelopmentOutage(env, OPENROUTER, 2)).toBe(false);
		expect(
			forcedDevelopmentOutage(
				{ ...env, YTIMESY_ENVIRONMENT: "production" },
				"codex",
				3,
			),
		).toBe(false);
		expect(forcedDevelopmentOutage({}, "codex", 3)).toBe(false);
		// Unset is not development.
		expect(
			forcedDevelopmentOutage(
				{ YTIMESY_DEV_FORCE_MODEL_OUTAGE: "codex@2" },
				"codex",
				3,
			),
		).toBe(false);
		expect(
			forcedDevelopmentOutage(
				{
					YTIMESY_DEV_FORCE_MODEL_OUTAGE: OPENROUTER,
					YTIMESY_ENVIRONMENT: "development",
				},
				OPENROUTER,
				1,
			),
		).toBe(true);
	});
});

describe("same-route retries", () => {
	const codex: ModelRoute = {
		connectionId: null,
		connectionRevision: subscriptionTurnRevision("high", false),
		modelId: "gpt-6.1-sol",
	};
	const other: ModelRoute = {
		connectionId: "11111111-1111-4111-8111-111111111111",
		connectionRevision: "or-rev",
		modelId: "openai/gpt-6.1-sol",
	};

	it("retries transient failures twice, never quotas, rate limits or a blocked egress", () => {
		expect(MODEL_STEP_RETRY_DELAYS_MS).toEqual([1_000, 3_000]);
		const outage = new IncompleteAgentTurn("error");
		expect(retriesSameRoute(outage, "outage")).toBe(true);
		expect(retriesSameRoute(apiError(504), "timeout")).toBe(true);
		expect(retriesSameRoute(apiError(529), "overloaded")).toBe(true);
		expect(retriesSameRoute(apiError(429), "rate-limited")).toBe(false);
		expect(
			retriesSameRoute(new SubscriptionUsageLimitReached(null), "usage-limit"),
		).toBe(false);
		const egress = new CodexEgressUnavailable([
			{ path: "direct", reason: "403" },
		]);
		expect(failoverReason(egress)).toBe("outage");
		expect(retriesSameRoute(egress, "outage")).toBe(false);
	});

	it("counts per route in the failover column, beside any switch", () => {
		expect(routeRetries(null, codex)).toBe(0);
		const once = withRouteRetries(null, codex, 1);
		expect(routeRetries(once, codex)).toBe(1);
		expect(routeRetries(once, other)).toBe(0);
		// A retry alone is not a failover: the turn keeps its own route.
		expect(turnFailover(once)).toBeNull();
		expect(withRouteRetries(once, codex, 0)).toEqual({});
		const switched = nextTurnFailover(
			null,
			{ route: codex, label: { model: "GPT-6.1-Sol", connection: "Codex" } },
			{
				route: other,
				connectionKey: other.connectionId as string,
				connectionLabel: "OpenRouter",
				modelLabel: "GPT-6.1 Sol",
				paid: true,
				sameModel: true,
			},
		);
		// The switch starts the new route without retries.
		expect(routeRetries(switched, other)).toBe(0);
		const retried = withRouteRetries(switched, other, 2);
		expect(routeRetries(retried, other)).toBe(2);
		expect(servingRoute({ ...turnRow(), failover: retried })).toMatchObject(
			other,
		);
		expect(servingRoute({ ...turnRow(), failover: once })).toEqual(
			chosenRoute(turnRow()),
		);
		expect(withRouteRetries(retried, other, 0)).toEqual(turnFailover(switched));
	});

	function turnRow() {
		return {
			connection_id: codex.connectionId,
			connection_revision: codex.connectionRevision,
			model_id: codex.modelId,
		};
	}
});

describe("fallbackAccountReason", () => {
	it("names a fallback's spent credit or refused key, never content or provider trouble", () => {
		expect(fallbackAccountReason(apiError(402))).toBe("out-of-credit");
		expect(
			fallbackAccountReason(
				new SafeApiModelFailure(
					apiError(400, { error: { code: "insufficient_credits" } }),
				),
			),
		).toBe("out-of-credit");
		expect(
			fallbackAccountReason(
				new Error(
					"You requested up to 64000 tokens, but can only afford 1253.",
				),
			),
		).toBe("out-of-credit");
		expect(fallbackAccountReason(apiError(401))).toBe("key-refused");
		expect(
			fallbackAccountReason(
				apiError(400, { error: { code: "invalid_api_key" } }),
			),
		).toBe("key-refused");
		expect(
			fallbackAccountReason(
				apiError(
					403,
					undefined,
					false,
					'{"error":{"message":"Input flagged by moderation"}}',
				),
			),
		).toBeNull();
		expect(fallbackAccountReason(apiError(503))).toBeNull();
		expect(
			fallbackAccountReason(
				apiError(400, { error: { code: "context_length_exceeded" } }),
			),
		).toBeNull();
		expect(fallbackAccountReason(new ApiTurnCancelled())).toBeNull();
		// The ChatGPT plan as a fallback, its sign-in needing renewal.
		expect(fallbackAccountReason(new CodexReconnectRequired())).toBe(
			"key-refused",
		);
		expect(failoverReason(new CodexReconnectRequired())).toBeNull();
		expect(
			failoverNotice(
				{ model: "GPT-6.1-Sol", connection: "Codex" },
				{ model: "Grok 4.7", connection: "SuperGrok" },
				"key-refused",
			),
		).toBe(
			"Codex needs reconnecting in Settings, so this chat continued on Grok 4.7 via SuperGrok.",
		);
		expect(
			failoverNotice(
				{ model: "GPT-6.1 Sol", connection: "OpenRouter" },
				{ model: "GPT-6.1-Sol", connection: "Codex" },
				"key-refused",
			),
		).toBe(
			"OpenRouter refused its key, so this chat continued on GPT-6.1-Sol via Codex.",
		);
		// On the route the user chose, these still stop the turn.
		expect(failoverReason(apiError(402))).toBeNull();
		expect(failoverReason(apiError(401))).toBeNull();
	});
});

describe("failureSummary", () => {
	it("keeps the failure chain short and redacted", () => {
		const summary = failureSummary(
			new SafeApiModelFailure(
				new APICallError({
					message: `Service Unavailable Bearer abc.def.ghi sk-${"a".repeat(30)} eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl https://relay.invalid/v1?token=secret ${"x".repeat(400)}`,
					url: "https://chatgpt.com/backend-api/codex/responses",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				}),
			),
		);
		expect(summary.length).toBeLessThanOrEqual(300);
		expect(summary).toContain("503: Service Unavailable");
		expect(summary).not.toMatch(/abc\.def|sk-a|eyJ|token=|secret/);
		expect(failureSummary(new IncompleteAgentTurn("error"))).toMatch(
			/^IncompleteAgentTurn \(error\): /,
		);
	});
});

describe("failoverChainFailure", () => {
	it("leads with a spent ChatGPT plan, then why the fallback failed", () => {
		const now = Date.parse("2026-10-30T00:40:00Z");
		const message = failoverChainFailure(
			[
				{
					kind: "modelSwitch",
					id: "t1:switch-1",
					state: "switched",
					reason: "usage-limit",
					message: "",
					from: { model: "GPT-6.1-Sol", connection: "Codex" },
					to: { model: "GPT-6.1 Sol", connection: "OpenRouter", key: "or" },
					resetsAt: now + 225 * 60_000,
				} as never,
			],
			"t1",
			"Your API provider account is out of credit.",
			now,
		);
		expect(message).toBe(
			"Your ChatGPT plan's Codex usage is used up (resets in 3 h 45 min). Switching to OpenRouter didn't work either: Your API provider account is out of credit.",
		);
		expect(failoverChainFailure([], "t1", "x", now)).toBeNull();
	});
});

describe("SuperGrok subscription", () => {
	const SUPERGROK = "00000000-0000-4000-8000-0000000000a1";
	const XAI_KEY = "00000000-0000-4000-8000-0000000000a2";
	const supergrok: FailoverConnection = {
		key: SUPERGROK,
		label: "SuperGrok",
		kind: "plan",
		provider: "compatible",
		baseUrl: "https://api.x.ai/v1",
		revision: "sg-rev",
		models: [{ id: "grok-4.7", label: "Grok 4.7" }],
	};
	const xaiKey: FailoverConnection = {
		...supergrok,
		key: XAI_KEY,
		label: "xAI",
		kind: "key",
		revision: "xk-rev",
	};
	const onSupergrok: ModelRoute = {
		connectionId: SUPERGROK,
		connectionRevision: "sg-rev",
		modelId: "grok-4.7",
		settings: {},
	};

	it("is a prepaid plan, ranked with subscriptions", () => {
		expect(
			failoverConnectionKind({
				provider: "compatible",
				baseUrl: "https://api.x.ai/v1",
				subscription: { provider: "xai", status: "ready" },
			}),
		).toBe("plan");
		expect(
			orderedFailoverConnections([xaiKey, supergrok]).map((row) => row.key),
		).toEqual([SUPERGROK, XAI_KEY]);
	});

	it("moves a rejected sign-in to the same Grok on an xAI key, with a notice", () => {
		for (const reason of ["reconnect", "not-eligible"] as const)
			expect(failoverReason(new XaiSubscriptionUnavailable(reason))).toBe(
				"plan-access",
			);
		// Wrapped by the SDK's safe failure, the cause still decides.
		expect(
			failoverReason(
				new SafeApiModelFailure(new XaiSubscriptionUnavailable("reconnect")),
			),
		).toBe("plan-access");
		expect(failoverReason(new XaiSubscriptionUnavailable("unavailable"))).toBe(
			"outage",
		);
		expect(
			retriesSameRoute(
				new XaiSubscriptionUnavailable("reconnect"),
				"plan-access",
			),
		).toBe(false);
		const [candidate] = failoverCandidates({
			original: onSupergrok,
			connections: [supergrok, xaiKey],
			tried: [routeKey(onSupergrok)],
		});
		expect(candidate).toMatchObject({
			connectionKey: XAI_KEY,
			modelLabel: "Grok 4.7",
			sameModel: true,
			paid: true,
		});
		expect(
			failoverNotice(
				{ model: "Grok 4.7", connection: "SuperGrok" },
				{ model: "Grok 4.7", connection: "xAI" },
				"plan-access",
			),
		).toBe(
			"SuperGrok needs reconnecting in Settings, so this chat continued on Grok 4.7 via xAI.",
		);
		// Leaving the prepaid plan for a key asks first when the user wants that.
		expect(
			decideFailover({
				policy: "any-model",
				switches: 0,
				serving: onSupergrok,
				candidates: [candidate],
				askBeforePaid: true,
				canAsk: true,
				servingPrepaid: true,
			}).kind,
		).toBe("ask");
	});

	it("is free to fail over onto", () => {
		const onKey = { ...onSupergrok, connectionId: XAI_KEY };
		const [candidate] = failoverCandidates({
			original: onKey,
			connections: [supergrok, xaiKey],
			tried: [routeKey(onKey)],
		});
		expect(candidate).toMatchObject({ connectionKey: SUPERGROK, paid: false });
	});
});

it("never fails over a workspace secrets failure to another model", () => {
	const failure = new ProjectSecretsPreparationFailure("directory", {
		kind: "timeout",
	});
	expect(failoverReason(failure)).toBeNull();
	expect(failoverReason(new Error("wrapped", { cause: failure }))).toBeNull();
});
