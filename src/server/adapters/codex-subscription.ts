import { z } from "zod";
import type { CodexUsage } from "#/domain/codex-usage";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import {
	codexExternalTokens,
	hasManagedCodexAuth,
} from "../auth/codex-managed-auth";
import { connectedLanguageModel } from "./api-model";

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

export async function codexSubscriptionModel(userId: string, modelId: string) {
	const catalog = z
		.object({
			models: z.array(
				z.object({
					slug: z.string(),
					context_window: z.number().positive().optional(),
				}),
			),
		})
		.parse(
			await subscriptionRequest(
				userId,
				`codex/models?client_version=${PINNED_CODEX_CLI_VERSION}`,
			),
		);
	const selected = catalog.models.find((row) => row.slug === modelId);
	if (!selected) throw new Error("Selected subscription model is unavailable.");
	const tokens = await codexExternalTokens(userId);
	const transport: typeof fetch = async (url, init) => {
		if (String(url) !== `${backend}/codex/responses`)
			throw new Error("Unexpected subscription inference destination.");
		const headers = new Headers(init?.headers);
		headers.set("ChatGPT-Account-ID", tokens.chatgptAccountId);
		return fetch(url, { ...init, headers, redirect: "error" });
	};
	return {
		model: connectedLanguageModel(
			{
				provider: "openai",
				baseUrl: `${backend}/codex`,
				modelId,
				apiKey: tokens.accessToken,
			},
			transport,
		),
		contextWindow: selected.context_window,
		requestSettings: (instructions: string) => ({
			providerOptions: {
				openai: {
					instructions,
					store: false,
					reasoningEffort: "low",
					reasoningSummary: "auto",
				},
			},
		}),
	};
}
