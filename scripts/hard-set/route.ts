// How a hard-set run reaches its model (docs/hard-set.md, "Models"): the
// owner's Codex subscription (the default), or a direct Google Gemini API key
// (development key in .secrets/gemini-api-key) on a connection created for
// each throwaway eval user.

export type HardSetRoute =
	| { kind: "codex"; modelId: string; recordModel: string }
	| { kind: "google"; modelId: string; recordModel: string };

/** `gpt-6.1-sol` (Codex subscription) or `google/gemini-3.8-flash` (Gemini API key). */
export function hardSetRoute(model: string): HardSetRoute {
	const google = /^google\/([a-z0-9._-]+)$/.exec(model);
	if (google) return { kind: "google", modelId: google[1], recordModel: model };
	if (!/^[a-z0-9._-]+$/.test(model))
		throw new Error(
			`Unexpected model "${model}": pass a Codex model id (gpt-6.1-sol) or google/<gemini model id>.`,
		);
	return { kind: "codex", modelId: model, recordModel: `codex:${model}` };
}

/** The harness and model id the shared eval-cost helper prices a record with. */
export function recordPricing(recordModel: string): {
	harness: "codex" | "api";
	modelId: string;
} {
	return recordModel.startsWith("codex:")
		? { harness: "codex", modelId: recordModel }
		: { harness: "api", modelId: recordModel };
}

const CODEX_USAGE = /usage limit is used up|usage_limit_reached/i;
// The product's message for a provider 429 (src/domain/api-turn-failure.ts).
const PROVIDER_RATE_LIMIT =
	/provider rate limit was reached|RESOURCE_EXHAUSTED|exceeded your current quota/i;

/**
 * Why a turn's stored errors mean the run hit a quota, or null. Such records
 * are not scored (docs/hard-set.md, Scoring) and stop the invocation.
 */
export function quotaStop(
	route: HardSetRoute["kind"],
	errorsJson: string,
): string | null {
	if (CODEX_USAGE.test(errorsJson))
		return (
			/Your ChatGPT plan's Codex usage limit[^"]*/.exec(errorsJson)?.[0] ??
			"Codex usage limit reached"
		);
	if (route === "google" && PROVIDER_RATE_LIMIT.test(errorsJson))
		return "Gemini rate limit reached (HTTP 429)";
	return null;
}

export type GeminiQuota =
	| { state: "ok" }
	| {
			state: "limited";
			/** A daily quota (or a reset hours away): stop this model for today. */
			daily: boolean;
			retryAfterSec: number | null;
			quotaIds: string[];
	  }
	| { state: "error"; status: number };

/**
 * Reads a Gemini generateContent response (one tiny probe request) into a
 * quota state. Never includes the key; the 429 body names the quota (e.g.
 * GenerateRequestsPerMinutePerProjectPerModel-FreeTier) and a RetryInfo delay.
 */
export function geminiQuotaFromResponse(
	status: number,
	body: string,
): GeminiQuota {
	if (status === 200) return { state: "ok" };
	if (status !== 429) return { state: "error", status };
	let details: unknown[] = [];
	try {
		details =
			(JSON.parse(body) as { error?: { details?: unknown[] } }).error
				?.details ?? [];
	} catch {}
	const quotaIds: string[] = [];
	let retryAfterSec: number | null = null;
	for (const detail of details as Record<string, unknown>[]) {
		for (const violation of (detail.violations as
			| { quotaId?: unknown }[]
			| undefined) ?? [])
			if (typeof violation.quotaId === "string")
				quotaIds.push(violation.quotaId);
		const delay =
			typeof detail.retryDelay === "string"
				? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay)
				: null;
		if (delay) retryAfterSec = Math.ceil(Number(delay[1]));
	}
	const daily =
		quotaIds.some((id) => /PerDay/i.test(id)) ||
		(retryAfterSec !== null && retryAfterSec > 15 * 60) ||
		// A quota of 0 for this model (e.g. not on the free tier) never resets.
		/limit: 0\b/.test(body);
	return { state: "limited", daily, retryAfterSec, quotaIds };
}
