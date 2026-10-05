import { APICallError } from "ai";

export type ApiTurnFailureStage =
	| "connection"
	| "workspace"
	| "budget"
	| "model"
	| "commit"
	| "saving";

export class SafeApiModelFailure extends Error {
	constructor(error: unknown) {
		super(apiModelFailureMessage(error));
		this.name = "SafeApiModelFailure";
	}
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
	if (error instanceof SafeApiModelFailure) return error.message;
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
		case "commit":
			return "The model finished, but automatic Git handoff failed. Your edits and local commits remain in the workspace. Check Git status, commit hooks, and GitHub access before continuing.";
	}
}
