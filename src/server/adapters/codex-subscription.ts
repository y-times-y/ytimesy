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
import {
	type ListedContextWindow,
	listedContextWindow,
} from "#/domain/context-window-option";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import {
	type ListedModel,
	listedReasoningFromRow,
} from "#/domain/listed-model";
import { isRetiredModel } from "#/domain/retired-model";
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
import {
	type InvocationSharedRead,
	invocationSharedRead,
	usableInThisInvocation,
} from "./database-scope";
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

async function subscriptionRequest(
	userId: string,
	path: string,
	/** A token read moments ago (sharedSubscriptionConnection); see subscriptionFetch. */
	loaded?: { accessToken: string; chatgptAccountId: string },
) {
	// Room for one blocked egress path (6s to headers) and the next one.
	const signal = AbortSignal.timeout(12_000);
	let response: Response;
	try {
		response = await subscriptionFetch(
			userId,
			path,
			{
				headers: {
					Accept: "application/json",
					"User-Agent": "ytimesy/1.0",
					Connection: "close",
				},
				// Return redirects for bounded HTTP diagnostics; never forward credentials.
				redirect: "manual",
				signal,
			},
			undefined,
			loaded,
		);
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
			// Only logged (codex.catalog): which models the account is offered at
			// the pinned client version, and any minimum version they carry.
			minimal_client_version: z.string().optional(),
			supported_reasoning_levels: z
				.array(z.object({ effort: z.string() }))
				.optional(),
			default_reasoning_level: z.string().optional(),
			priority: z.number().optional(),
			context_window: z.number().positive().optional(),
			// "Maximum context window allowed for config overrides" (Codex's
			// openai_models.rs): Codex's `model_context_window` may raise the
			// window up to it. Only local compaction limits change; nothing about
			// the window is sent with a request.
			max_context_window: z.number().positive().nullish(),
			auto_compact_token_limit: z.number().positive().nullish(),
			// Fast mode, as Codex reads it: a "priority" service tier, or the
			// older "fast" speed tier.
			service_tiers: z.array(z.object({ id: z.string() })).optional(),
			additional_speed_tiers: z.array(z.string()).optional(),
		}),
	),
});
type CatalogRow = z.infer<typeof catalogSchema>["models"][number];
const FAST_SERVICE_TIER = "priority";

function supportsFast(row: CatalogRow) {
	return (
		row.service_tiers?.some((tier) => tier.id === FAST_SERVICE_TIER) === true ||
		row.additional_speed_tiers?.includes("fast") === true
	);
}

/**
 * The larger window a plan model allows, as Codex applies
 * `model_context_window`: offered only when `max_context_window` exceeds the
 * standard `context_window`.
 */
export function codexContextWindowOption(
	row: Pick<CatalogRow, "context_window" | "max_context_window">,
): ListedContextWindow | undefined {
	return listedContextWindow({
		standard: row.context_window,
		alternate:
			row.max_context_window &&
			row.context_window &&
			row.max_context_window > row.context_window
				? row.max_context_window
				: undefined,
		note: CODEX_LARGE_CONTEXT_NOTE,
	});
}
/** Longer prompts use more of the plan's limits (developers.openai.com/codex/pricing). */
const CODEX_LARGE_CONTEXT_NOTE = "Longer chats use your plan's limits faster";

/**
 * The window and compaction limit a turn runs with. The larger window drops
 * the catalog's auto-compact limit, which was set for the standard window;
 * the budget then derives from the larger window, as Codex derives 90% of
 * an overridden window.
 */
export function codexTurnContext(
	row: Pick<
		CatalogRow,
		"context_window" | "max_context_window" | "auto_compact_token_limit"
	>,
	alternateContext: boolean,
): { contextWindow?: number; autoCompactTokenLimit?: number } {
	const option = alternateContext ? codexContextWindowOption(row) : undefined;
	if (option) return { contextWindow: option.alternate };
	return {
		contextWindow: row.context_window,
		autoCompactTokenLimit: row.auto_compact_token_limit ?? undefined,
	};
}
type Catalog = z.infer<typeof catalogSchema>;
/**
 * Fresh for 15 minutes; past that, served (up to 6 hours) while a refresh
 * runs. A plan's models change rarely: the browsers decide when to ask again
 * (CODEX_CATALOG_EPOCH), and a forced read skips the fresh copy.
 */
const CATALOG_FRESH_MS = 15 * 60_000;
const CATALOG_STALE_MS = 6 * 3600_000;
type CatalogEntry = {
	expires: number;
	/** A load of this entry is still running (one in flight per user). */
	pending?: boolean;
	promise: Promise<Catalog>;
	/** The last catalog read, kept as plain data (never a pending request). */
	value?: { catalog: Catalog; until: number };
} & InvocationSharedRead;
const catalogs = new Map<string, CatalogEntry>();

/**
 * A step reads the account's token once: the catalog read and the model
 * runtime that follow within seconds share it (each read is a database round
 * trip and an unseal). Codex tokens are handed out with at least five minutes
 * left, and a revoked one is answered 401 and re-read (withRevokedTokenRetry),
 * so a token this recent is as good as a new read. A failed read is not kept.
 */
const CONNECTION_REUSE_MS = 20_000;
type SubscriptionConnection = Awaited<
	ReturnType<typeof subscriptionConnection>
>;
const connections = new Map<
	string,
	{
		at: number;
		promise: Promise<SubscriptionConnection>;
	} & InvocationSharedRead
>();

function sharedSubscriptionConnection(userId: string) {
	const now = Date.now();
	const cached = connections.get(userId);
	if (
		cached &&
		now >= cached.at &&
		now - cached.at < CONNECTION_REUSE_MS &&
		usableInThisInvocation(cached)
	)
		return cached;
	if (connections.size >= 1000 && !cached)
		connections.delete(connections.keys().next().value as string);
	const promise = subscriptionConnection(userId);
	const entry = { at: now, promise, ...invocationSharedRead(promise) };
	connections.set(userId, entry);
	entry.promise.catch(() => {
		if (connections.get(userId) === entry) connections.delete(userId);
	});
	return entry;
}

/** Test hook: forget shared token reads between cases. */
export function forgetSubscriptionConnectionsForTests() {
	connections.clear();
}

function loadCatalog(
	userId: string,
	previous?: { catalog: Catalog; until: number },
) {
	if (catalogs.size >= 1000 && !catalogs.has(userId))
		catalogs.delete(catalogs.keys().next().value as string);
	const promise = sharedSubscriptionConnection(userId)
		.promise.catch(() => undefined)
		.then((connection) =>
			subscriptionRequest(
				userId,
				`codex/models?client_version=${PINNED_CODEX_CLI_VERSION}`,
				connection,
			),
		)
		.then((value) => catalogSchema.parse(value))
		.then((catalog) => {
			// One line per catalog load: model names only (no ids of people), so a
			// missing model can be told apart from a hidden or version-gated one.
			console.info("codex.catalog", {
				clientVersion: PINNED_CODEX_CLI_VERSION,
				count: catalog.models.length,
				models: catalog.models
					.slice(0, 40)
					.map(
						(row) =>
							`${row.slug}${row.visibility ? `:${row.visibility}` : ""}${row.minimal_client_version ? `@${row.minimal_client_version}` : ""}`,
					),
			});
			return catalog;
		});
	const entry: CatalogEntry = {
		expires: Date.now() + CATALOG_FRESH_MS,
		promise,
		pending: true,
		...(previous ? { value: previous } : {}),
		...invocationSharedRead(promise),
	};
	catalogs.set(userId, entry);
	promise.then(
		(catalog) => {
			entry.pending = false;
			entry.value = { catalog, until: Date.now() + CATALOG_STALE_MS };
		},
		() => {
			entry.pending = false;
			// A failed refresh keeps a still-valid earlier catalog; otherwise the
			// next read loads again.
			if (catalogs.get(userId) !== entry) return;
			if (previous && previous.until > Date.now())
				catalogs.set(userId, {
					expires: 0,
					promise,
					value: previous,
					owner: undefined,
					settled: true,
				});
			else catalogs.delete(userId);
		},
	);
	return promise;
}

async function subscriptionCatalog(
	userId: string,
	options: { force?: boolean } = {},
) {
	if (!(await hasManagedCodexAuth(userId))) {
		catalogs.delete(userId);
		throw new Error("Connect Codex before starting this agent.");
	}
	const cached = catalogs.get(userId);
	// A forced read skips the fresh copy and is answered by a new load, unless
	// one is already running: that one is as fresh as a new one.
	if (options.force && !(cached?.pending && usableInThisInvocation(cached)))
		return loadCatalog(userId, cached?.value);
	const fresh = !!cached && cached.expires > Date.now();
	if (cached && fresh && usableInThisInvocation(cached)) return cached.promise;
	// Past a minute (or while another request refreshes it): answer from the
	// last catalog, refreshing it alongside when no refresh runs.
	const stale = cached?.value;
	if (stale && stale.until > Date.now()) {
		if (!fresh) loadCatalog(userId, stale).catch(() => {});
		return stale.catalog;
	}
	return loadCatalog(userId);
}

/**
 * Starts loading the account's model catalog so a step's remaining setup
 * overlaps it; the model runtime awaits the same cached load, and a failure
 * is reported there.
 */
export function warmCodexSubscriptionCatalog(userId: string) {
	subscriptionCatalog(userId).catch(() => {});
	// The model runtime's token read, likewise (sharedSubscriptionConnection).
	sharedSubscriptionConnection(userId).promise.catch(() => {});
}

export async function codexSubscriptionCatalog(
	userId: string,
	options: { force?: boolean } = {},
): Promise<ListedModel[]> {
	const catalog = await subscriptionCatalog(userId, options);
	return catalog.models
		.filter((row) => row.visibility !== "hide" && !isRetiredModel(row.slug))
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
		.map((row) => ({
			id: row.slug,
			...(row.context_window ? { contextCapacity: row.context_window } : {}),
			label: row.display_name ?? row.slug,
			reasoning: listedReasoningFromRow({
				supportedReasoningEfforts: row.supported_reasoning_levels?.map(
					(level) => level.effort,
				),
				defaultReasoningEffort: row.default_reasoning_level,
			}),
			...(supportsFast(row) ? { speeds: [{ id: "fast" as const }] } : {}),
			...(codexContextWindowOption(row)
				? { contextWindow: codexContextWindowOption(row) }
				: {}),
		}));
}

export async function codexSubscriptionModel(
	userId: string,
	modelId: string,
	reasoning?: string,
	fast = false,
	cacheScopeId: string = randomUUID(),
	alternateContext = false,
) {
	// The catalog and the account's token are independent reads; a catalog
	// failure is still reported first.
	const shared = sharedSubscriptionConnection(userId);
	const [listed, connected] = await Promise.allSettled([
		subscriptionCatalog(userId),
		shared.promise,
	]);
	if (listed.status === "rejected") throw listed.reason;
	const catalog = listed.value;
	const selected = catalog.models.find((row) => row.slug === modelId);
	// Plans change which models a ChatGPT account may use; the catalog is per account.
	if (!selected)
		throw new Error(
			"The selected model is no longer available on your current Codex plan. Choose another model.",
		);
	if (fast && !supportsFast(selected))
		throw new Error(
			"Fast mode is not available for this model on your ChatGPT plan.",
		);
	if (alternateContext && !codexContextWindowOption(selected))
		throw new Error(
			"A larger context window is not available for this model on your ChatGPT plan.",
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
		at: shared.at,
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
				...(fast ? { serviceTier: FAST_SERVICE_TIER } : {}),
				// Independent tool calls may share a response. Authorization and
				// write/lease fencing remain enforced by each tool's executor.
				parallelToolCalls: true,
			},
		},
	});
	return {
		model,
		...codexTurnContext(selected, alternateContext),
		// Initial reads use a stable preflight prefix; complete current bodies and
		// hashed read receipts prevent a second mandatory-guidance fetch.
		prefetchInitialReads: true,
		// The backend refuses unstreamed requests; the harness's own summary
		// (its fallback when it declines a native compaction) streams.
		streamOnly: true,
		requestSettings,
		compact: nativeModelCompactor(model, "openai", requestSettings),
	};
}
