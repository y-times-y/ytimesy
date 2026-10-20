import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { z } from "zod";
import {
	CodexEgressUnavailable,
	CodexReconnectRequired,
	SubscriptionMetadataFailure,
	SubscriptionUsageLimitReached,
	usageLimitReset,
} from "#/domain/api-turn-failure";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import type { CodexUsage } from "#/domain/codex-usage";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import {
	type ListedModel,
	listedReasoningFromRow,
} from "#/domain/listed-model";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import {
	recordStepTiming,
	stepTimingEnabled,
	timed,
} from "../services/step-timing";
import { connectedLanguageModel } from "./api-model";
import { promptCacheScopeKey } from "./api-prompt-cache";
import {
	subscriptionConnection,
	subscriptionFetch,
} from "./codex-subscription-transport";
import { nativeModelCompactor } from "./model-compaction";

/** Diagnostics only: records request start to the first streamed body byte. */
function timedFirstByte(response: Response, startedAt: number) {
	if (!response.body || !stepTimingEnabled()) return response;
	let seen = false;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (!seen) {
					seen = true;
					recordStepTiming(
						"model:firstByte",
						Date.now() - startedAt,
						startedAt,
					);
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, response);
}

const backend = "https://chatgpt.com/backend-api";
const windowSchema = z.object({
	used_percent: z.number().min(0).max(100),
	limit_window_seconds: z.number().positive(),
	reset_at: z.number().nonnegative(),
});
const rateSchema = z.object({
	primary_window: windowSchema.nullish(),
	secondary_window: windowSchema.nullish(),
});
const limitsSchema = z.object({
	rate_limit: rateSchema.nullish(),
	additional_rate_limits: z
		.array(
			z.object({
				limit_name: z.string(),
				metered_feature: z.string(),
				rate_limit: rateSchema,
			}),
		)
		.nullish(),
});

export function subscriptionLimits(
	value: unknown,
	now = Date.now(),
): CodexUsage {
	const payload = limitsSchema.parse(value);
	const normalize = (
		rate: z.infer<typeof rateSchema>,
		id: string,
		name?: string,
	) => {
		const window = (row: z.infer<typeof windowSchema> | null | undefined) =>
			row
				? {
						usedPercent: row.used_percent,
						windowDurationMins: row.limit_window_seconds / 60,
						resetsAt: row.reset_at,
					}
				: null;
		return {
			limitId: id,
			limitName: name,
			primary: window(rate.primary_window),
			secondary: window(rate.secondary_window),
		};
	};
	const buckets = Object.fromEntries([
		...(payload.rate_limit
			? [["codex", normalize(payload.rate_limit, "codex")]]
			: []),
		...(payload.additional_rate_limits ?? []).map((row) => [
			row.metered_feature,
			normalize(row.rate_limit, row.metered_feature, row.limit_name),
		]),
	]);
	return { updatedAt: now / 1000, limits: { rateLimitsByLimitId: buckets } };
}

async function subscriptionRequest(userId: string, path: string) {
	// Room for one blocked egress path (6s to headers) and the next one.
	const signal = AbortSignal.timeout(12_000);
	let response: Response;
	try {
		response = await subscriptionFetch(userId, path, {
			headers: {
				Accept: "application/json",
				"User-Agent": "ytimesy/1.0",
				Connection: "close",
			},
			// Return redirects for bounded HTTP diagnostics; never forward credentials.
			redirect: "manual",
			signal,
		});
	} catch (error) {
		if (
			error instanceof CodexReconnectRequired ||
			error instanceof CodexEgressUnavailable
		)
			throw error;
		throw new SubscriptionMetadataFailure(
			signal.aborted ||
				(error instanceof Error && error.name === "TimeoutError")
				? "timeout"
				: "transport",
		);
	}
	if (!response.ok) {
		const challenge = response.headers.get("cf-mitigated") === "challenge";
		await response.body?.cancel().catch(() => {});
		throw new SubscriptionMetadataFailure(
			challenge ? "access-challenge" : response.status,
		);
	}
	try {
		return JSON.parse(
			await readBoundedRequestBody(response, 2 * 1024 * 1024),
		) as unknown;
	} catch {
		throw new SubscriptionMetadataFailure("invalid-response");
	}
}

/** Account-scoped metadata only: no runner/VM wake and no model inference. */
export async function readCodexSubscriptionUsage(
	userId: string,
): Promise<CodexUsage | undefined> {
	if (!(await hasManagedCodexAuth(userId))) return undefined;
	return subscriptionLimits(await subscriptionRequest(userId, "wham/usage"));
}

const catalogSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().optional(),
			visibility: z.string().optional(),
			supported_reasoning_levels: z
				.array(z.object({ effort: z.string() }))
				.optional(),
			default_reasoning_level: z.string().optional(),
			priority: z.number().optional(),
			context_window: z.number().positive().optional(),
			auto_compact_token_limit: z.number().positive().nullish(),
		}),
	),
});
const catalogs = new Map<
	string,
	{ expires: number; promise: Promise<z.infer<typeof catalogSchema>> }
>();

async function subscriptionCatalog(userId: string) {
	if (!(await hasManagedCodexAuth(userId))) {
		catalogs.delete(userId);
		throw new Error("Connect Codex before starting this agent.");
	}
	const cached = catalogs.get(userId);
	if (cached && cached.expires > Date.now()) return cached.promise;
	if (catalogs.size >= 1000)
		catalogs.delete(catalogs.keys().next().value as string);
	const promise = subscriptionRequest(
		userId,
		`codex/models?client_version=${PINNED_CODEX_CLI_VERSION}`,
	).then((value) => catalogSchema.parse(value));
	catalogs.set(userId, { expires: Date.now() + 60_000, promise });
	try {
		return await promise;
	} catch (error) {
		catalogs.delete(userId);
		throw error;
	}
}

/**
 * Starts loading the account's model catalog so a step's remaining setup
 * overlaps it; the model runtime awaits the same cached load, and a failure
 * is reported there.
 */
export function warmCodexSubscriptionCatalog(userId: string) {
	subscriptionCatalog(userId).catch(() => {});
}

export async function codexSubscriptionCatalog(
	userId: string,
): Promise<ListedModel[]> {
	const catalog = await subscriptionCatalog(userId);
	return catalog.models
		.filter((row) => row.visibility !== "hide")
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
		.map((row) => ({
			id: row.slug,
			label: row.display_name ?? row.slug,
			reasoning: listedReasoningFromRow({
				supportedReasoningEfforts: row.supported_reasoning_levels?.map(
					(level) => level.effort,
				),
				defaultReasoningEffort: row.default_reasoning_level,
			}),
		}));
}

export async function codexSubscriptionModel(
	userId: string,
	modelId: string,
	reasoning?: string,
	fast = false,
	cacheScopeId: string = randomUUID(),
) {
	// The catalog and the account's token are independent reads; a catalog
	// failure is still reported first.
	const [listed, connected] = await Promise.allSettled([
		subscriptionCatalog(userId),
		subscriptionConnection(userId),
	]);
	if (listed.status === "rejected") throw listed.reason;
	const catalog = listed.value;
	const selected = catalog.models.find((row) => row.slug === modelId);
	// Plans change which models a ChatGPT account may use; the catalog is per account.
	if (!selected)
		throw new Error(
			"The selected model is no longer available on your current Codex plan. Choose another model.",
		);
	if (fast)
		throw new Error(
			"Fast mode is not available on this subscription transport.",
		);
	const effort = reasoning ?? selected.default_reasoning_level ?? "low";
	if (
		selected.supported_reasoning_levels?.length &&
		!selected.supported_reasoning_levels.some(
			(level) => level.effort === effort,
		)
	)
		throw new Error("Selected reasoning level is unavailable for this model.");
	if (connected.status === "rejected") throw connected.reason;
	const tokens = connected.value;
	// The step's first request reuses the token just read (fresh for at least
	// five more minutes); later requests and a 401 retry read it again.
	let loaded: { tokens: typeof tokens; at: number } | undefined = {
		tokens,
		at: Date.now(),
	};
	const cacheKey = promptCacheScopeKey({
		userId,
		connectionId: `codex-subscription:${tokens.chatgptAccountId}`,
		scopeId: cacheScopeId,
	});
	const transport: typeof fetch = async (url, init) => {
		if (String(url) !== `${backend}/codex/responses`)
			throw new Error("Unexpected subscription inference destination.");
		const headers = new Headers(init?.headers);
		// The pinned native ChatGPT transport derives cache affinity from this header.
		headers.set("session-id", cacheKey);
		// Long reasoning steps leave unrelated pooled HTTP/1 sockets idle. Do not
		// retain them across steps; this does not retry or replay a returned stream.
		headers.set("Connection", "close");
		const startedAt = Date.now();
		const reused =
			loaded && startedAt - loaded.at < 60_000 ? loaded.tokens : undefined;
		loaded = undefined;
		const response = await timed("model:headers", () =>
			subscriptionFetch(
				userId,
				"codex/responses",
				{ ...init, method: "POST", headers },
				tokens.chatgptAccountId,
				reused,
			),
		);
		// A spent plan allowance answers 429 like a rate limit, but retrying cannot help.
		if (response.status === 429) {
			const limit = usageLimitReset(await response.clone().text());
			if (limit !== undefined) {
				await response.body?.cancel();
				throw new SubscriptionUsageLimitReached(limit);
			}
		}
		// rl-tests-sol: a 200 with no body ("Failed to process successful
		// response", the SDK's EmptyResponseBodyError) failed the turn. Nothing
		// was streamed or executed, so this is a request-start failure the
		// SDK's bounded retry may resend; any stream that started is never
		// replayed.
		if (response.ok && !response.body)
			throw new APICallError({
				message: "The provider accepted the request but sent no response body.",
				url: String(url),
				requestBodyValues: {},
				statusCode: response.status,
				isRetryable: true,
			});
		return timedFirstByte(response, startedAt);
	};
	const model = connectedLanguageModel(
		{
			provider: "openai",
			baseUrl: `${backend}/codex`,
			modelId,
			apiKey: tokens.accessToken,
		},
		transport,
	);
	const requestSettings = (instructions: string) => ({
		providerOptions: {
			openai: {
				instructions,
				store: false,
				promptCacheKey: cacheKey,
				reasoningEffort: effort,
				reasoningSummary: "auto",
				// Independent tool calls may share a response. Authorization and
				// write/lease fencing remain enforced by each tool's executor.
				parallelToolCalls: true,
			},
		},
	});
	return {
		model,
		contextWindow: selected.context_window,
		// Initial reads use a stable preflight prefix; complete current bodies and
		// hashed read receipts prevent a second mandatory-guidance fetch.
		prefetchInitialReads: true,
		autoCompactTokenLimit: selected.auto_compact_token_limit ?? undefined,
		requestSettings,
		compact: nativeModelCompactor(model, "openai", requestSettings),
	};
}
