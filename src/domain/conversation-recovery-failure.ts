import { MachineUsageLimitReached } from "./api-turn-failure";

/**
 * A recovery refusal the user can act on (stop a turn, pick another
 * message, retry). Its message is written for them and shown as is.
 */
export class RecoveryRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryRefused";
	}
}

export type RecoveryMode = "conversation" | "code" | "both" | "fork";

/**
 * What the user sees when recovery fails: a refusal's own message, or one
 * short generic line. Anything else (provider, database, usage-admission
 * errors) can carry internal details, so it is logged on the server only.
 */
export function publicRecoveryFailure(error: unknown, mode: RecoveryMode) {
	if (
		error instanceof RecoveryRefused ||
		error instanceof MachineUsageLimitReached
	)
		return error.message;
	return mode === "fork"
		? "Couldn't fork this chat. Try again."
		: "Couldn't restore this point. Try again.";
}
