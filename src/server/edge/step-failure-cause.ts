import { redactSecrets } from "#/domain/redact-secrets";

/**
 * What a failed chat step threw, for the log: the error's name and message and
 * the first lines of its stack (where it was thrown), redacted and bounded.
 * Never throws: it runs inside a failure handler.
 */
export function stepFailureCause(error: unknown): string {
	try {
		if (error instanceof Error) {
			const stack = (error.stack ?? "").split("\n").slice(0, 4).join(" | ");
			return redactSecrets(`${error.name}: ${error.message} @ ${stack}`, 700);
		}
		return redactSecrets(String(error), 300);
	} catch {
		return "unreadable error";
	}
}
