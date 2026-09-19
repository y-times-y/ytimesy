export type GithubAppBotIdentity = {
	readonly name: string;
	readonly email: string;
};

export function githubAppBotIdentity(app: {
	readonly id: string;
	readonly slug: string;
}): GithubAppBotIdentity | null {
	const id = app.id.trim();
	const slug = app.slug.trim();
	if (!/^\d+$/.test(id) || !/^[a-z0-9-]+$/.test(slug)) return null;
	return {
		name: `${slug}[bot]`,
		email: `${id}+${slug}[bot]@users.noreply.github.com`,
	};
}

export function githubAppBotFromEnv(
	env: {
		readonly GITHUB_APP_ID?: string;
		readonly GITHUB_APP_SLUG?: string;
	} = process.env,
) {
	return githubAppBotIdentity({
		id: env.GITHUB_APP_ID ?? "",
		slug: env.GITHUB_APP_SLUG ?? "",
	});
}
