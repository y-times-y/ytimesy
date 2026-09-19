export type GithubAppBotIdentity = {
	readonly name: string;
	readonly email: string;
};

export function githubAppBotIdentity(app: {
	readonly userId: string;
	readonly slug: string;
}): GithubAppBotIdentity | null {
	const userId = app.userId.trim();
	const slug = app.slug.trim();
	if (!/^\d+$/.test(userId) || !/^[a-z0-9-]+$/.test(slug)) return null;
	return {
		name: `${slug}[bot]`,
		email: `${userId}+${slug}[bot]@users.noreply.github.com`,
	};
}

export function githubAppBotFromEnv(
	env: {
		readonly GITHUB_APP_BOT_USER_ID?: string;
		readonly GITHUB_APP_SLUG?: string;
	} = process.env,
) {
	return githubAppBotIdentity({
		userId: env.GITHUB_APP_BOT_USER_ID ?? "",
		slug: env.GITHUB_APP_SLUG ?? "",
	});
}
