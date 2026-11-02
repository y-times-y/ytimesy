import { Cause, Runtime } from "effect";
import { publicFailureMessage } from "#/domain/project-workspace";

/**
 * A server function's failure, made readable for the client. A thrown
 * Response (bare, or inside an Effect failure) serializes to "{}", so it
 * becomes an Error with the response's body text. Anything else is returned
 * as it was.
 */
export async function readableServerError(cause: unknown): Promise<unknown> {
	const inner = Runtime.isFiberFailure(cause)
		? Cause.squash(cause[Runtime.FiberFailureCauseId])
		: cause;
	if (!(inner instanceof Response)) return cause;
	const body = await inner.text().catch(() => "");
	return new Error(body.trim() || publicFailureMessage(inner));
}
