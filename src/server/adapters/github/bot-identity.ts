import {
	type GithubAppBotIdentity,
	githubAppBotFromEnv,
	githubAppBotIdentity,
} from "#/domain/github-bot";

export async function resolveGithubAppBot(
	env: NodeJS.ProcessEnv = process.env,
): Promise<GithubAppBotIdentity | null> {
	const fromEnv = githubAppBotFromEnv(env);
	if (fromEnv) return fromEnv;
	const slug = env.GITHUB_APP_SLUG?.trim() ?? "";
	if (!/^[a-z0-9-]+$/.test(slug)) return null;
	const response = await fetch(
		`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "ytimesy",
			},
		},
	);
	if (!response.ok) return null;
	const body = (await response.json()) as { id?: unknown };
	if (typeof body.id !== "number") return null;
	return githubAppBotIdentity({ userId: String(body.id), slug });
}
