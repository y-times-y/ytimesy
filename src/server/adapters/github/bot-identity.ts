import {
	type GithubAppBotIdentity,
	githubAppBotFromEnv,
	githubAppBotIdentity,
} from "#/domain/github-bot";
import { githubInstallationAccessToken } from "./installation-token";

/** The bot's GitHub user id never changes; one lookup per isolate and slug. */
const lookedUp = new Map<string, GithubAppBotIdentity>();

export type GithubAppBotLookup = (input: {
	readonly slug: string;
	readonly installationId: number | string;
	readonly repositoryName?: string;
}) => Promise<number | null>;

/**
 * GET /users/<slug>[bot] with an installation token. Unauthenticated calls
 * from Cloudflare are rate-limited, so the public lookup is never used.
 */
const installationLookup: GithubAppBotLookup = async (input) => {
	const token = await githubInstallationAccessToken(
		input.installationId,
		input.repositoryName
			? { repositoryNames: [input.repositoryName], contents: "read" }
			: undefined,
	);
	const response = await fetch(
		`https://api.github.com/users/${encodeURIComponent(`${input.slug}[bot]`)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "ytimesy",
			},
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
	const body = (await response.json()) as { id?: unknown };
	return typeof body.id === "number" ? body.id : null;
};

/**
 * The App's bot (`<slug>[bot]`), credited as Co-authored-by on every commit
 * ytimesy makes on a user's branch. Configured by GITHUB_APP_SLUG and
 * GITHUB_APP_BOT_USER_ID (`gh api users/<slug>%5Bbot%5D --jq .id`). When the
 * id is missing it is looked up with the App's installation token and a
 * warning is logged; null (also logged) only when that fails too.
 */
export async function resolveGithubAppBot(
	options: {
		readonly installationId?: number | string | null;
		readonly repositoryName?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly lookup?: GithubAppBotLookup;
	} = {},
): Promise<GithubAppBotIdentity | null> {
	const env = options.env ?? process.env;
	const fromEnv = githubAppBotFromEnv(env);
	if (fromEnv) return fromEnv;
	const slug = env.GITHUB_APP_SLUG?.trim() ?? "";
	if (!/^[a-z0-9-]+$/.test(slug)) {
		console.warn(
			"GITHUB_APP_SLUG is not set; commits carry no Co-authored-by trailer for the GitHub App.",
		);
		return null;
	}
	const known = lookedUp.get(slug);
	if (known) return known;
	console.warn(
		`GITHUB_APP_BOT_USER_ID is not set; looking up ${slug}[bot] with the App's installation token. Set it (gh api users/${slug}%5Bbot%5D --jq .id) to skip this lookup.`,
	);
	if (options.installationId == null || options.installationId === "") {
		console.warn(
			"No GitHub installation to look up the App's bot with; this commit carries no Co-authored-by trailer for the App.",
		);
		return null;
	}
	try {
		const id = await (options.lookup ?? installationLookup)({
			slug,
			installationId: options.installationId,
			repositoryName: options.repositoryName,
		});
		const identity =
			id === null ? null : githubAppBotIdentity({ userId: String(id), slug });
		if (!identity) throw new Error("GitHub returned no bot user id.");
		lookedUp.set(slug, identity);
		return identity;
	} catch (error) {
		console.warn(
			"The GitHub App's bot could not be looked up; this commit carries no Co-authored-by trailer for the App.",
			{
				message:
					error instanceof Error ? error.message.slice(0, 300) : "unknown",
			},
		);
		return null;
	}
}
