import { APICallError, RetryError } from "ai";
import {
	ApiModelPreparationFailure,
	ApiTurnCancelled,
	CodexEgressUnavailable,
	CodexReconnectRequired,
	ContextWindowExhausted,
	IncompleteAgentTurn,
	InitialAgentReadFailure,
	LifecycleHookRefusal,
	SubscriptionMetadataFailure,
	SubscriptionUsageLimitReached,
	UnsupportedEdgeModelEndpoint,
} from "./api-turn-failure";
import type { FailoverReason } from "./model-failover";
import { publicToolDetail } from "./tool-detail";

/** Failures a different route cannot fix: the user (or the request) must change. */
const NEVER_FAIL_OVER = [
	ApiTurnCancelled,
	ContextWindowExhausted,
	CodexReconnectRequired,
	ApiModelPreparationFailure,
	UnsupportedEdgeModelEndpoint,
	InitialAgentReadFailure,
	LifecycleHookRefusal,
];

/** Provider codes for caller problems, including permanent quota and refusals. */
const CALLER_CODES = new Set([
	"invalid_request_error",
	"invalid_request",
	"invalid_tool_arguments",
	"unsupported_tool",
	"context_length_exceeded",
	"insufficient_quota",
	"insufficient_credits",
	"billing_hard_limit_reached",
	"invalid_api_key",
	"authentication_error",
	"permission_error",
	"model_not_found",
	"invalid_model",
	"not_found_error",
	"request_too_large",
	"content_filter",
	"content_policy_violation",
]);

/** Streamed error types (Anthropic, OpenAI, gateways) that name a provider-side problem. */
const PROVIDER_TYPES: Record<string, FailoverReason> = {
	overloaded_error: "overloaded",
	rate_limit_error: "rate-limited",
	rate_limit_exceeded: "rate-limited",
	api_error: "outage",
	server_error: "outage",
	internal_error: "outage",
	internal_server_error: "outage",
	service_unavailable: "outage",
	service_unavailable_error: "outage",
	timeout_error: "timeout",
};

const INTERRUPTED =
	/\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|terminated|fetch failed|other side closed|network error)\b/i;

type ErrorRecord = {
	name?: unknown;
	message?: unknown;
	code?: unknown;
	type?: unknown;
	statusCode?: unknown;
	data?: unknown;
	error?: unknown;
	cause?: unknown;
	providerError?: unknown;
};

/** The provider's own failure chain, outermost first: retry wrappers, our safe wrapper, causes. */
function failureChain(error: unknown) {
	const chain: unknown[] = [];
	let current = error;
	for (let depth = 0; depth < 8; depth++) {
		if (!current || chain.includes(current)) break;
		chain.push(current);
		if (typeof current !== "object") break;
		const record = current as ErrorRecord;
		current = RetryError.isInstance(current)
			? current.lastError
			: (record.providerError ??
				record.cause ??
				(record.error && typeof record.error === "object"
					? record.error
					: undefined));
	}
	return chain;
}

function strings(record: ErrorRecord, field: "code" | "type") {
	const nested = (value: unknown) =>
		value && typeof value === "object" ? (value as ErrorRecord) : undefined;
	const data = nested(record.data);
	return [record, data, nested(data?.error), nested(record.error)].flatMap(
		(row) =>
			typeof row?.[field] === "string"
				? [(row[field] as string).toLowerCase()]
				: [],
	);
}

function statusReason(
	status: number,
	text: string,
): FailoverReason | null | undefined {
	if (status === 429) return "rate-limited";
	if (status === 529) return "overloaded";
	if (status === 408 || status === 504 || status === 524) return "timeout";
	if (status >= 500)
		return /overloaded|over capacity/i.test(text) ? "overloaded" : "outage";
	if (status >= 400) return null;
	// A failed 200 stream says nothing by its status; its cause may.
	return undefined;
}

/** Why a model step failed in a way another route can fix, or null when it must not move. */
export function failoverReason(error: unknown): FailoverReason | null {
	const chain = failureChain(error);
	// Typed domain failures decide first, wherever an SDK wrapped them.
	for (const current of chain) {
		if (NEVER_FAIL_OVER.some((type) => current instanceof type)) return null;
		if (current instanceof SubscriptionUsageLimitReached) return "usage-limit";
		// Every egress path is blocked: another provider route still works.
		if (current instanceof CodexEgressUnavailable) return "outage";
		if (current instanceof SubscriptionMetadataFailure)
			return current.reason === "timeout"
				? "timeout"
				: current.reason === "transport" ||
						(typeof current.reason === "number" && current.reason >= 500)
					? "outage"
					: null;
		if (current instanceof IncompleteAgentTurn)
			return current.reason === "error" ? "outage" : null;
	}
	for (const current of chain) {
		if (typeof current !== "object" || current === null) continue;
		const record = current as ErrorRecord;
		if (strings(record, "code").some((code) => CALLER_CODES.has(code)))
			return null;
		const type = strings(record, "type").find((row) => row in PROVIDER_TYPES);
		if (type) return PROVIDER_TYPES[type];
		const message = typeof record.message === "string" ? record.message : "";
		if (typeof record.statusCode === "number") {
			const reason = statusReason(
				record.statusCode,
				`${message} ${APICallError.isInstance(current) ? (current.responseBody ?? "") : ""}`.slice(
					0,
					4096,
				),
			);
			if (reason !== undefined) return reason;
		}
		if (/overloaded|over capacity|capacity constraints/i.test(message))
			return "overloaded";
		if (record.name === "TimeoutError") return "timeout";
		if (
			(typeof record.code === "string" && INTERRUPTED.test(record.code)) ||
			INTERRUPTED.test(message)
		)
			return "outage";
		if (
			APICallError.isInstance(current) &&
			current.statusCode === undefined &&
			current.isRetryable
		)
			return "outage";
	}
	return null;
}

const TRANSIENT: readonly FailoverReason[] = [
	"outage",
	"timeout",
	"overloaded",
];

/**
 * A failure a moment later may fix on the same route. Quotas and rate limits
 * are not, nor is a blocked Codex egress: every path was already tried.
 */
export function retriesSameRoute(error: unknown, reason: FailoverReason) {
	return (
		TRANSIENT.includes(reason) &&
		!failureChain(error).some(
			(current) => current instanceof CodexEgressUnavailable,
		)
	);
}

/** Why a model step failed, for the record: names, statuses and messages, redacted and short. */
export function failureSummary(error: unknown): string {
	const parts = failureChain(error).flatMap((current) => {
		if (typeof current !== "object" || current === null)
			return typeof current === "string" ? [current] : [];
		const record = current as ErrorRecord;
		const label = [
			current instanceof IncompleteAgentTurn
				? `IncompleteAgentTurn (${current.reason})`
				: typeof record.name === "string"
					? record.name
					: "",
			typeof record.statusCode === "number" ? String(record.statusCode) : "",
		]
			.filter(Boolean)
			.join(" ");
		const text = [
			label,
			typeof record.message === "string" ? record.message : "",
		]
			.filter(Boolean)
			.join(": ")
			.replace(/\s+/g, " ")
			.trim();
		return text ? [text] : [];
	});
	const summary = publicToolDetail(
		parts.filter((part, index) => parts.indexOf(part) === index).join(" <- "),
	)
		// Bearer JWTs and URL query strings (signed links) are never kept.
		.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
		.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1");
	return summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
}

/** The synthetic provider failure a forced development outage raises. */
export function developmentOutageError() {
	return new APICallError({
		message: "Service Unavailable (forced development outage)",
		url: "https://development.invalid/forced-outage",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: true,
	});
}
