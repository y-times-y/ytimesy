import { Effect } from "effect";
import { MissingGitHubAppCredentials } from "#/server/services/errors";

export type GitHubAppCredentials = {
	readonly appId: string;
	readonly privateKey: string;
	readonly slug: string | null;
};

export function normalizeGitHubPrivateKey(value: string): string {
	return value.replaceAll("\\n", "\n").trim();
}

export function readGitHubAppCredentials(
	env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<GitHubAppCredentials, MissingGitHubAppCredentials> {
	const appId = env.GITHUB_APP_ID?.trim() ?? "";
	const privateKey = normalizeGitHubPrivateKey(env.GITHUB_PRIVATE_KEY ?? "");
	if (!appId || !privateKey.includes("BEGIN")) {
		return Effect.fail(
			new MissingGitHubAppCredentials({
				message: "GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required",
			}),
		);
	}
	return Effect.succeed({
		appId,
		privateKey,
		slug: env.GITHUB_APP_SLUG?.trim() || null,
	});
}
