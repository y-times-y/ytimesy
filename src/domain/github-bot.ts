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

export function githubAppBotFromEnv(env: {
	readonly GITHUB_APP_BOT_USER_ID?: string;
	readonly GITHUB_APP_SLUG?: string;
}) {
	return githubAppBotIdentity({
		userId: env.GITHUB_APP_BOT_USER_ID ?? "",
		slug: env.GITHUB_APP_SLUG ?? "",
	});
}

/**
 * Comments posted before the handle followed the App's slug told people to
 * write `@ytimesy`. That is an unrelated GitHub user, so it is never printed
 * again; it is still understood so those older pull requests keep working.
 */
const LEGACY_MENTION = "ytimesy";

function validSlug(slug: string | null | undefined) {
	const value = slug?.trim() ?? "";
	return /^[a-z0-9-]+$/.test(value) ? value : null;
}

/** The handle people write on GitHub to reach ytimesy: the App's own name, like `@claude`. */
export function githubAppMention(slug: string | null | undefined) {
	const value = validSlug(slug);
	return value ? `@${value}` : null;
}

/**
 * `@<slug>` (or `@<slug>[bot]`, or the legacy `@ytimesy`) as a whole
 * mention: not part of an e-mail address, a path or a longer handle.
 */
export function githubAppMentionPattern(slug: string | null | undefined) {
	const value = validSlug(slug);
	const handles = [
		...(value && value !== LEGACY_MENTION ? [`${value}(?:\\[bot\\])?`] : []),
		LEGACY_MENTION,
	];
	return new RegExp(`(^|[^\\w@/.-])@(?:${handles.join("|")})(?![\\w-])`, "i");
}
