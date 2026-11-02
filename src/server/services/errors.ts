import { Data, Effect } from "effect";

export class MissingFreestyleApiKey extends Data.TaggedError(
	"MissingFreestyleApiKey",
)<{
	readonly message: string;
}> {}

export class MissingGitHubAppCredentials extends Data.TaggedError(
	"MissingGitHubAppCredentials",
)<{
	readonly message: string;
}> {}

export class WorkspaceProvisionError extends Data.TaggedError(
	"WorkspaceProvisionError",
)<{
	readonly operation: "create" | "destroy" | "reconcile" | "snapshot";
	readonly message: string;
	readonly providerWorkspaceId?: string;
	/** The raw provider failure, redacted (machine-failure.ts): for logs and the owner, never the user's message. */
	readonly detail?: string;
}> {}

export class WorkspaceCommandError extends Data.TaggedError(
	"WorkspaceCommandError",
)<{
	readonly operation: "exec" | "writeFile" | "readFile";
	readonly message: string;
	readonly providerWorkspaceId: string;
}> {}

/**
 * A failure the user can correct, with the message they should see. Routes
 * unwrap `UnknownException.error`, so the Response reaches the client as-is;
 * a bare `throw` inside `Effect.gen` would instead become a defect and a 502.
 */
export function rejectRequest(message: string, status = 409) {
	return Effect.tryPromise(async (): Promise<never> => {
		throw new Response(message, { status });
	});
}
