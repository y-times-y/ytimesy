import type { PublicationAuthor } from "./publication";

const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Commit author for the authenticated GitHub account.
 * Uses the profile email when GitHub returned one. Otherwise uses GitHub's
 * own noreply address `id+login@users.noreply.github.com`, which belongs to
 * that account. Returns null when the login is missing, or when neither an
 * email nor a numeric id is present: callers must not invent a name or email.
 */
export function githubCommitIdentity(profile: {
	readonly login?: string | null;
	readonly id?: number | null;
	readonly name?: string | null;
	readonly email?: string | null;
}): PublicationAuthor | null {
	const login = profile.login?.trim() ?? "";
	if (!GITHUB_LOGIN.test(login)) return null;
	const email = profileEmail(profile.email) ?? noreplyEmail(profile.id, login);
	if (!email) return null;
	return { name: profileName(profile.name, login), email };
}

/** Shown when a commit had to keep the ytimesy author instead of a GitHub user. */
export const UNATTRIBUTED_COMMIT_NOTICE =
	"Commits use the ytimesy author because GitHub did not return a login and email for the connected account.";

function profileEmail(email: string | null | undefined) {
	const value = email?.trim() ?? "";
	if (value.length > 254) return null;
	if (!/^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(value)) return null;
	return value;
}

function noreplyEmail(id: number | null | undefined, login: string) {
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
		return null;
	return `${id}+${login}@users.noreply.github.com`;
}

function profileName(name: string | null | undefined, login: string) {
	const value = name?.replace(/\s+/g, " ").trim() ?? "";
	if (!value || value.length > 100 || /[<>\r\n]/.test(value)) return login;
	return value;
}
