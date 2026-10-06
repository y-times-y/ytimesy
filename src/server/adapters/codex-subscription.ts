import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CodexUsage } from "#/domain/codex-usage";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import {
	type ListedModel,
	listedReasoningFromRow,
} from "#/domain/listed-model";
import {
	codexExternalTokens,
	hasManagedCodexAuth,
} from "../auth/codex-managed-auth";
import { connectedLanguageModel } from "./api-model";
import { promptCacheScopeKey } from "./api-prompt-cache";
import { nativeModelCompactor } from "./model-compaction";

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
	const tokens = await codexExternalTokens(userId);
	const response = await fetch(`${backend}/${path}`, {
		headers: {
			Authorization: `Bearer ${tokens.accessToken}`,
			"ChatGPT-Account-ID": tokens.chatgptAccountId,
		},
		redirect: "error",
		signal: AbortSignal.timeout(7_000),
	});
	if (!response.ok)
		throw new Error(`Subscription metadata unavailable (${response.status}).`);
	return response.json() as Promise<unknown>;
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
	const catalog = await subscriptionCatalog(userId);
	const selected = catalog.models.find((row) => row.slug === modelId);
	if (!selected) throw new Error("Selected subscription model is unavailable.");
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
	const tokens = await codexExternalTokens(userId);
	const cacheKey = promptCacheScopeKey({
		userId,
		connectionId: `codex-subscription:${tokens.chatgptAccountId}`,
		scopeId: cacheScopeId,
	});
	const transport: typeof fetch = async (url, init) => {
		if (String(url) !== `${backend}/codex/responses`)
			throw new Error("Unexpected subscription inference destination.");
		const headers = new Headers(init?.headers);
		const current = await codexExternalTokens(userId);
		if (current.chatgptAccountId !== tokens.chatgptAccountId)
			throw new Error("Subscription account changed; restart this turn.");
		headers.set("Authorization", `Bearer ${current.accessToken}`);
		headers.set("ChatGPT-Account-ID", current.chatgptAccountId);
		// The pinned native ChatGPT transport derives cache affinity from this header.
		headers.set("session-id", cacheKey);
		return fetch(url, { ...init, headers, redirect: "error" });
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
		// Keep a stable reusable prefix while below the working-context target.
		// Under pressure, recoverable retirement precedes opaque native compaction.
		workingContextTokens: 64_000,
		coordinationWorkingContextTokens: 48_000,
		archiveConsumedGuidance: true,
		// Initial reads use a stable preflight prefix; complete current bodies and
		// hashed read receipts prevent a second mandatory-guidance fetch.
		prefetchInitialReads: true,
		autoCompactTokenLimit: selected.auto_compact_token_limit ?? undefined,
		requestSettings,
		compact: nativeModelCompactor(model, "openai", requestSettings),
	};
}
