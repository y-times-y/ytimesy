import {
	type GithubAppBotIdentity,
	githubAppBotFromEnv,
	githubAppBotIdentity,
} from "#/domain/github-bot";

/** The bot's GitHub user id never changes; one lookup per isolate and slug. */
const lookedUp = new Map<string, GithubAppBotIdentity>();

export async function resolveGithubAppBot(
	env: NodeJS.ProcessEnv = process.env,
): Promise<GithubAppBotIdentity | null> {
	const fromEnv = githubAppBotFromEnv(env);
	if (fromEnv) return fromEnv;
	const slug = env.GITHUB_APP_SLUG?.trim() ?? "";
	if (!/^[a-z0-9-]+$/.test(slug)) return null;
	const known = lookedUp.get(slug);
	if (known) return known;
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
	const identity = githubAppBotIdentity({ userId: String(body.id), slug });
	if (identity) lookedUp.set(slug, identity);
	return identity;
}
