import { Data } from "effect";

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
}> {}

export class WorkspaceCommandError extends Data.TaggedError(
	"WorkspaceCommandError",
)<{
	readonly operation: "exec" | "writeFile" | "readFile";
	readonly message: string;
	readonly providerWorkspaceId: string;
}> {}
