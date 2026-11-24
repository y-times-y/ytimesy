import { Cause } from "effect";
import { publicFailureMessage } from "#/domain/project-workspace";

/**
 * A server function's failure, made readable for the client. A thrown
 * Response (bare, or inside an Effect failure) serializes to "{}", so it
 * becomes an Error with the response's body text. Anything else is returned
 * as it was.
 */
export async function readableServerError(cause: unknown): Promise<unknown> {
	// Effect.runPromise rejects with the failure itself (the squashed cause),
	// so a Response is bare; a Cause that reaches here is squashed the same way.
	const inner = Cause.isCause(cause) ? Cause.squash(cause) : cause;
	if (!(inner instanceof Response)) return cause;
	const body = await inner.text().catch(() => "");
	return new Error(body.trim() || publicFailureMessage(inner));
}
