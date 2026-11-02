import type { RepositoryChoice } from "../../../domain/projects";

/** How long a confirmed repository access is reused without asking GitHub again. */
export const REPOSITORY_ACCESS_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

type AccessKey = {
	readonly userId: string;
	readonly installationId: number;
	readonly repositoryId: number;
};

/**
 * Remembers, per isolate, that a user may use a repository through an
 * installation, so repeated reads (opening a pull request again, polling the
 * list) skip GitHub's installation and repository listings.
 *
 * Only granted access is kept, and only for the TTL: a denial is never cached,
 * so a new grant works at once, and a revoked one stops within the TTL. Inside
 * that window GitHub still checks every call made with the user's token, which
 * only reaches repositories the user and the installation can both access.
 * Callers that change a repository (merge, ready) should not use this cache.
 */
export function repositoryAccessCache({
	ttlMs = REPOSITORY_ACCESS_TTL_MS,
	maxEntries = MAX_ENTRIES,
	now = Date.now,
}: {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
} = {}) {
	const entries = new Map<
		string,
		{ readonly access: Promise<RepositoryChoice>; readonly expiresAt: number }
	>();
	const keyOf = (key: AccessKey) =>
		`${key.userId}:${key.installationId}:${key.repositoryId}`;
	return {
		/** The cached access, else the check's answer (shared by concurrent callers). */
		access(key: AccessKey, check: () => Promise<RepositoryChoice>) {
			const id = keyOf(key);
			const cached = entries.get(id);
			if (cached && cached.expiresAt > now()) return cached.access;
			entries.delete(id);
			for (const [entry, { expiresAt }] of entries)
				if (expiresAt <= now()) entries.delete(entry);
			while (entries.size >= maxEntries) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
			const access = check();
			entries.set(id, { access, expiresAt: now() + ttlMs });
			access.catch(() => {
				if (entries.get(id)?.access === access) entries.delete(id);
			});
			return access;
		},
		/** Drops a user's access, e.g. after GitHub refused a call with it. */
		forget(key: AccessKey) {
			entries.delete(keyOf(key));
		},
		/** A catch handler: GitHub refused the token here, so the next read checks again. */
		refused(key: AccessKey) {
			return (error: unknown): never => {
				const status =
					typeof error === "object" && error !== null && "status" in error
						? error.status
						: null;
				if (status === 401 || status === 403 || status === 404)
					entries.delete(keyOf(key));
				throw error;
			};
		},
	};
}

/** This isolate's cache for the in-app pull request reads. */
export const repositoryAccess = repositoryAccessCache();
