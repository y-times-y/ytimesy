import { APICallError, RetryError } from "ai";

export type ApiTurnFailureStage =
	| "connection"
	| "workspace"
	| "budget"
	| "model"
	| "commit"
	| "coordination"
	| "saving";

const FAILURE_NAMES = new Set([
	"Error",
	"TypeError",
	"TimeoutError",
	"AbortError",
	"SafeApiModelFailure",
	"APICallError",
	"AI_APICallError",
	"RetryableCoordinationFailure",
]);
const FAILURE_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"EPIPE",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"ERR_STREAM_PREMATURE_CLOSE",
	"23505",
	"40001",
	"40P01",
	"55P03",
	"57014",
	"53300",
	"57P01",
	"08000",
	"08003",
	"08006",
	"08001",
	"08004",
	"08007",
	"08P01",
]);

/** Only predefined diagnostic categories may leave the worker; error text never does. */
export function apiTurnFailureClassification(error: unknown) {
	const name = error instanceof Error ? error.name : "unknown";
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: "unknown";
	return {
		name: FAILURE_NAMES.has(name) ? name : "unknown",
		code: FAILURE_CODES.has(code) ? code : "unknown",
	};
}

export class SafeApiModelFailure extends Error {
	readonly classification: ApiModelFailureClassification;

	constructor(error: unknown) {
		super(apiModelFailureMessage(error));
		this.name = "SafeApiModelFailure";
		this.classification = apiModelFailureClassification(error);
	}
}

type ApiModelFailureClassification = ReturnType<
	typeof apiTurnFailureClassification
> & {
	httpStatus: number | null;
	providerCode: string;
	causes: ReturnType<typeof apiTurnFailureClassification>[];
};

const PROVIDER_FAILURE_CODES = new Set([
	"internal_error",
	"server_error",
	"invalid_request_error",
	"invalid_request",
	"invalid_tool_arguments",
	"unsupported_tool",
	"context_length_exceeded",
	"rate_limit_exceeded",
	"insufficient_quota",
	"insufficient_credits",
	"invalid_api_key",
	"model_not_found",
	"invalid_model",
	"content_filter",
]);

/** Bounded diagnostics only: never log a provider message, body, URL or request. */
export function apiModelFailureClassification(
	error: unknown,
): ApiModelFailureClassification {
	for (let depth = 0; depth < 3 && RetryError.isInstance(error); depth++)
		error = error.lastError;
	if (error instanceof SafeApiModelFailure) return error.classification;
	const status = APICallError.isInstance(error) ? error.statusCode : undefined;
	const code = APICallError.isInstance(error)
		? providerErrorCode(error.data)
		: undefined;
	return {
		...apiTurnFailureClassification(error),
		httpStatus:
			Number.isInteger(status) &&
			status !== undefined &&
			status >= 100 &&
			status <= 599
				? status
				: null,
		providerCode: code && PROVIDER_FAILURE_CODES.has(code) ? code : "unknown",
		causes: modelFailureCauses(error),
	};
}

function modelFailureCauses(error: unknown) {
	const causes: ReturnType<typeof apiTurnFailureClassification>[] = [];
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4; depth++) {
		if (!error || typeof error !== "object" || !("cause" in error)) break;
		error = error.cause;
		if (!error || seen.has(error)) break;
		seen.add(error);
		causes.push(apiTurnFailureClassification(error));
	}
	return causes;
}

export class IncompleteAgentTurn extends Error {
	constructor(reason: string) {
		super(
			reason === "tool-calls"
				? "The agent reached its tool-step limit without a final result. Work is preserved; continue this task instead of starting a duplicate."
				: "The agent stopped without a complete final result. Work is preserved; continue this task.",
		);
	}
}

function providerErrorCode(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const nested =
		record.error && typeof record.error === "object"
			? (record.error as Record<string, unknown>)
			: record;
	return typeof nested.code === "string"
		? nested.code.toLowerCase()
		: undefined;
}

export function apiModelFailureMessage(error: unknown): string {
	// Retry wrappers carry raw request data; classify only their final error, with a bounded unwrap.
	for (let depth = 0; depth < 3 && RetryError.isInstance(error); depth++)
		error = error.lastError;
	if (error instanceof SafeApiModelFailure) return error.message;
	if (
		error instanceof Error &&
		error.message === "Private checkpoint storage is not configured."
	)
		return "Private checkpoint storage is not configured. Work and original context were preserved; configure archive storage before continuing. This is a harness configuration failure, not a provider rejection.";
	if (APICallError.isInstance(error)) {
		const code = providerErrorCode(error.data);
		const detail = `${error.message} ${error.responseBody ?? ""}`.slice(
			0,
			4096,
		);
		const inspectDetails =
			error.statusCode === undefined ||
			error.statusCode === 400 ||
			error.statusCode === 413 ||
			error.statusCode === 422;
		if (code === "insufficient_quota" || code === "insufficient_credits")
			return "The provider account has insufficient credit or quota. Add credit or choose a funded connection. No fallback was used.";
		if (code === "rate_limit_exceeded")
			return "The provider rate limit was reached. Wait and retry. No fallback was used.";
		if (code === "invalid_api_key")
			return "The provider rejected this API key. Update the key in Model connections. No fallback was used.";
		if (code === "model_not_found" || code === "invalid_model")
			return "The selected model is unavailable from this provider. Choose another model. No fallback was used.";
		if (
			code === "context_length_exceeded" ||
			(inspectDetails &&
				/context.{0,40}(length|window)|maximum.{0,30}tokens|prompt.{0,30}too long/i.test(
					detail,
				))
		)
			return "The model rejected this conversation because it exceeds its context window. Start a new chat with a handoff summary. No fallback was used.";
		if (
			code === "unsupported_tool" ||
			(inspectDetails &&
				/does not support.{0,30}(tools|function calling)|tool_choice.{0,30}(unsupported|invalid)/i.test(
					detail,
				))
		)
			return "This model does not support the tool calls needed for coding. Choose another model. No fallback was used.";
		switch (error.statusCode) {
			case 200:
				return "The provider accepted the request but its response stream failed. Work is preserved; inspect it before continuing. No fallback or stream replay was used.";
			case 401:
				return "The provider rejected this API key (HTTP 401). Update the key in Model connections. No fallback was used.";
			case 402:
				return "The provider reported insufficient credit (HTTP 402). Add credit to that provider account. No fallback was used.";
			case 403:
				return "This API key does not have access to the selected model (HTTP 403). Check the account or choose another model. No fallback was used.";
			case 404:
				return "The selected model is unavailable from this provider (HTTP 404). Choose another model. No fallback was used.";
			case 408:
			case 504:
				return "The provider timed out. Retry this turn. No fallback was used.";
			case 413:
				return "The provider rejected the request because it is too large (HTTP 413). Shorten the conversation or start a new chat. No fallback was used.";
			case 429:
				return "The provider rate limit was reached (HTTP 429). Wait and retry. No fallback was used.";
		}
		if (error.statusCode && error.statusCode >= 500)
			return `The provider is unavailable (HTTP ${error.statusCode}). Retry later. No fallback was used.`;
		if (error.statusCode)
			return `The provider rejected this request (HTTP ${error.statusCode}). Check model access, context size, and tool support. No fallback was used.`;
		if (error.isRetryable)
			return "The provider could not be reached or returned a temporary error. Retry this turn. No fallback was used.";
	}
	if (error instanceof Error) {
		if (error.message.includes("selected model is no longer available"))
			return "The selected model is no longer available on this connection. Choose another model. No fallback was used.";
		if (error.name === "TimeoutError")
			return "The model request timed out. Retry this turn. No fallback was used.";
		if (
			error instanceof TypeError &&
			/fetch failed|network error/i.test(error.message)
		)
			return "The provider could not be reached. Check the connection and retry. No fallback was used.";
	}
	return "The model request failed without a usable provider reason. Check the connection and retry. No fallback was used.";
}

export function apiTurnFailureMessage(
	stage: ApiTurnFailureStage,
	error?: unknown,
): string {
	if (error instanceof IncompleteAgentTurn) return error.message;
	switch (stage) {
		case "connection":
			return "The selected API connection changed or was removed. Select a model again; no fallback was used.";
		case "workspace":
			if (
				error instanceof Error &&
				error.message === "Prepared repository path is unavailable."
			)
				return "The prepared repository is missing from this workspace. Repair the environment before retrying.";
			if (
				error instanceof Error &&
				/(?:LIMIT_EXCEEDED|vcpu_time|memory_time|allowance)/i.test(
					error.message,
				)
			)
				return "The workspace VM limit or compute allowance was reached. Free capacity or wait for the allowance to reset.";
			return "The workspace could not start or its prepared repository is unavailable. Check the workspace and retry.";
		case "budget":
			if (
				error instanceof Error &&
				error.message.includes(
					"conversation exceeds the API context safety limit",
				)
			)
				return "This conversation exceeds the API context safety limit. Start a new chat with a handoff summary; no model request was sent.";
			return "The API usage safety limit blocked this run before a model request. Check usage before retrying.";
		case "model":
			return apiModelFailureMessage(error);
		case "saving":
			return "The run could not save its latest progress. Check the workspace and connection before retrying.";
		case "coordination":
			return "The conversation coordinator could not confirm this turn's ownership or completion. Work is preserved; inspect the latest task state before continuing.";
		case "commit":
			return "The model finished, but automatic Git handoff failed. Your edits and local commits remain in the workspace. Check Git status, commit hooks, and GitHub access before continuing.";
	}
}
