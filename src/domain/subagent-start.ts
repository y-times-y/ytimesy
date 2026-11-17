import {
	EFFECT_GENERIC_FAILURE,
	usageCapFailureMessage,
} from "./failure-message";

/**
 * Where in the `agent` tool's start path a helper failed to start. Logged as
 * `subagent.start_failed` (docs/subagent-start.md).
 */
export type SubagentStartStage =
	| "open"
	| "save-spec"
	| "fork"
	| "reserve"
	| "bind-machine"
	| "enqueue-first-turn"
	| "unknown";

/** Waits before retry 1 and retry 2 (the first attempt is immediate). */
export const SUBAGENT_START_BACKOFF_MS = [400, 1200] as const;
export const SUBAGENT_START_ATTEMPTS = SUBAGENT_START_BACKOFF_MS.length + 1;

const PERMANENT =
	/budget|admission|depth|too deep|too many|already running|no longer available|not available|is required|must be read-only|missing its brief|no model|usage limit|allowance|LIMIT_EXCEEDED|at its (?:VM )?limit|limit of \d+|cap\b|exhausted|unauthori[sz]ed|forbidden|\b40[0-4]\b|invalid/i;
const TRANSIENT =
	/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|network|timed? ?out|timeout|\b5\d\d\b|bad gateway|service unavailable|overloaded|temporar|try again|resource busy|\bbusy\b|lease|lock|deadlock|serialization|could not serialize|connection terminated|didn't say why|did not say why|refused|rate limit|\b429\b|unknown error occurred|snapshot|copy/i;

/** Whether a failure is worth retrying: permanent causes win over transient ones. */
export function isTransientStartFailure(message: string): boolean {
	if (!message.trim()) return true;
	if (usageCapFailureMessage(message)) return false;
	if (PERMANENT.test(message)) return false;
	return TRANSIENT.test(message);
}

/** The reason in plain words; never the provider's or Effect's own text. */
export function plainStartReason(
	stage: SubagentStartStage,
	message: string,
): string {
	if (/timed? ?out|timeout|ETIMEDOUT/i.test(message))
		return "the machine took too long to respond";
	if (/busy|lease|lock|deadlock|serializ/i.test(message))
		return "the machine was busy";
	if (
		/ECONNRESET|ECONNREFUSED|EPIPE|socket|network|fetch failed|EAI_AGAIN/i.test(
			message,
		)
	)
		return "the connection dropped";
	if (
		/\b5\d\d\b|bad gateway|unavailable|overloaded|didn't say why|did not say why/i.test(
			message,
		)
	)
		return "the model provider had a hiccup";
	if (stage === "fork") return "the machine copy was refused";
	if (stage === "bind-machine") return "the machine wasn't ready";
	if (stage === "enqueue-first-turn")
		return "its first step couldn't be queued";
	return "a temporary problem on our side";
}

export class SubagentStartError extends Error {
	readonly _tag = "SubagentStartError";
	/** The original error's message, for the log only (never shown). */
	readonly causeMessage: string;
	constructor(
		readonly stage: SubagentStartStage,
		cause: unknown,
		readonly retryable: boolean,
		readonly attempts = 1,
	) {
		const causeMessage = rawMessage(cause);
		super(causeMessage);
		this.name = "SubagentStartError";
		this.causeMessage = causeMessage;
		this.cause = cause;
	}
}

/** Wraps a rejection with its stage; classifies it unless already typed. */
export function startStageError(
	stage: SubagentStartStage,
	cause: unknown,
): SubagentStartError {
	if (cause instanceof SubagentStartError) return cause;
	return new SubagentStartError(
		stage,
		cause,
		isTransientStartFailure(rawMessage(cause)),
	);
}

/** An error whose message is plain words already, thrown to the model and shown to the user. */
export class SubagentStartRefused extends Error {
	readonly retryable: boolean;
	readonly stage: SubagentStartStage;
	constructor(message: string, stage: SubagentStartStage, retryable: boolean) {
		super(message);
		this.name = "SubagentStartRefused";
		this.stage = stage;
		this.retryable = retryable;
	}
}

export function couldntStartMessage(
	stage: SubagentStartStage,
	causeMessage: string,
	attempts: number,
): string {
	return `Couldn't start the helper (${plainStartReason(stage, causeMessage)}). I retried ${attempts} times. Try again in a moment; nothing was changed.`;
}

export const COULDNT_START_PREFIX = "Couldn't start the helper";

/** Walks UnknownException / FiberFailure wrappers to the innermost real message. */
export function rawMessage(cause: unknown, depth = 0): string {
	if (cause == null || depth > 6) return "";
	if (typeof cause === "string") return cause.trim();
	if (typeof cause !== "object") return "";
	const record = cause as {
		error?: unknown;
		cause?: unknown;
		message?: unknown;
	};
	for (const inner of [record.error, record.cause]) {
		const text = rawMessage(inner, depth + 1);
		if (text && text !== EFFECT_GENERIC_FAILURE) return text;
	}
	return typeof record.message === "string" ? record.message.trim() : "";
}

/** True when text carries Effect's or the runtime's internal wording. */
export function hasInternalFailureText(text: string): boolean {
	return /Effect\.tryPromise|FiberFailure|UnknownException|\(FiberFailure\)/.test(
		text,
	);
}
