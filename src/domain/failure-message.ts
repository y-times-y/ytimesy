import {
	USAGE_CEILING_REFUSAL_PATTERN,
	USAGE_WINDOW_REFUSAL_PATTERN,
} from "./infrastructure-usage";

/**
 * Effect's default message for `Effect.tryPromise(fn)` without a `catch`:
 * "An error occurred in Effect.tryPromise" since Effect 4 (Effect 3 said
 * "An unknown error occurred ..."; stored failures can still carry it).
 */
export const EFFECT_GENERIC_FAILURE = "An error occurred in Effect.tryPromise";
const GENERIC_EFFECT_PROMISE_TEXT =
	/An (?:unknown )?error occurred in Effect\.tryPromise/;
/** True for exactly Effect's default tryPromise message (either version). */
export function isGenericEffectText(text: string): boolean {
	return /^An (?:unknown )?error occurred in Effect\.tryPromise$/.test(
		text.trim(),
	);
}
export const GENERIC_SERVER_FAILURE =
	"Something went wrong on our side. It's been logged; try again.";

/**
 * The generic boundary: text that reaches a tool result or the UI. Effect's
 * default text (and its FiberFailure wrapper) becomes plain words, with the
 * stage when the failure carries one.
 */
export function plainFailureText(text: string, stage?: string): string {
	if (
		!/Effect\.tryPromise|FiberFailure|UnknownException|UnknownError/.test(text)
	)
		return text;
	return stage
		? `${GENERIC_SERVER_FAILURE} (stage: ${stage})`
		: GENERIC_SERVER_FAILURE;
}

function failureStage(cause: unknown, depth = 0): string | undefined {
	if (!cause || typeof cause !== "object" || depth > 6) return undefined;
	const record = cause as { stage?: unknown; error?: unknown; cause?: unknown };
	if (typeof record.stage === "string") return record.stage;
	return (
		failureStage(record.error, depth + 1) ??
		failureStage(record.cause, depth + 1)
	);
}

export function failureMessage(cause: unknown): string {
	const message = unwrapFailureMessage(cause, new Set());
	if (!message && hasGenericEffectText(cause))
		return plainFailureText(EFFECT_GENERIC_FAILURE, failureStage(cause));
	return (
		(message && usageCapFailureMessage(message)) ||
		message ||
		"Something went wrong."
	);
}

export const USER_USAGE_CAP_MESSAGE =
	"You have reached your cloud usage limit, so new machine time cannot start. Your work is preserved; the limit refills over the next hours (see Settings for the exact time).";
export const FLEET_MONTHLY_CAP_MESSAGE =
	"The ytimesy free beta has used its shared cloud budget for this month, so new machine time cannot start. Your work is preserved; the budget resets on the 1st (UTC). Questions: support@ytimesy.com.";
export const FLEET_LIFETIME_CAP_MESSAGE =
	"The ytimesy free beta has used its total cloud budget, so new machine time cannot start. Your work is preserved; we will reopen capacity as soon as we can. Questions: support@ytimesy.com.";

/**
 * The user-facing wording for a usage cap refusal (src/server/adapters/
 * infrastructure-usage.ts), or null when the text is not one. Fleet caps are
 * the beta's shared budget, not something the user did or can fix.
 */
export function usageCapFailureMessage(message: string): string | null {
	const window = USAGE_WINDOW_REFUSAL_PATTERN.exec(message);
	if (window) return window[0];
	const ceiling = USAGE_CEILING_REFUSAL_PATTERN.exec(message);
	if (ceiling) return ceiling[0];
	if (/lifetime fleet cloud execution budget is exhausted/i.test(message))
		return FLEET_LIFETIME_CAP_MESSAGE;
	if (/fleet cloud execution budget is exhausted/i.test(message))
		return FLEET_MONTHLY_CAP_MESSAGE;
	if (/your cloud execution allowance is exhausted/i.test(message))
		return USER_USAGE_CAP_MESSAGE;
	return null;
}

export function workspaceLooksGone(message: string): boolean {
	if (/codex binary not found/i.test(message)) return false;
	return /not found|404|does not exist|unknown vm|no such (?:workspace|vm|machine)|deleted/i.test(
		message,
	);
}

export function isWorkspaceAtCapacity(message: string) {
	return /LIMIT_EXCEEDED|limit of \d+ VMs|at its VM limit|at its limit|Pausing a VM does not free a slot|Pausing does not free a slot/i.test(
		message,
	);
}

export function isWorkspaceComputeAllowanceExhausted(message: string) {
	return /allowance for vcpu_time|memory_time has been used|compute allowance|vCPU-hour allowance/i.test(
		message,
	);
}

function hasGenericEffectText(cause: unknown, depth = 0): boolean {
	if (typeof cause === "string") return GENERIC_EFFECT_PROMISE_TEXT.test(cause);
	if (!cause || typeof cause !== "object" || depth > 6) return false;
	const record = cause as {
		message?: unknown;
		error?: unknown;
		cause?: unknown;
	};
	return (
		(typeof record.message === "string" &&
			GENERIC_EFFECT_PROMISE_TEXT.test(record.message)) ||
		hasGenericEffectText(record.error, depth + 1) ||
		hasGenericEffectText(record.cause, depth + 1)
	);
}

function unwrapFailureMessage(cause: unknown, seen: Set<unknown>): string {
	if (cause == null) return "";
	if (typeof cause === "string") {
		const text = cause.trim();
		return isGenericEffectText(text) ? "" : text;
	}
	if (typeof cause !== "object") return "";
	if (seen.has(cause)) return "";
	seen.add(cause);
	const record = cause as {
		error?: unknown;
		cause?: unknown;
		message?: unknown;
	};
	const nested = unwrapFailureMessage(record.error, seen);
	if (nested) return nested;
	const innerCause = unwrapFailureMessage(record.cause, seen);
	if (innerCause) return innerCause;
	if (typeof record.message === "string") {
		const text = record.message.trim();
		if (text && !isGenericEffectText(text)) return text;
	}
	return "";
}
