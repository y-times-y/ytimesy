import { Octokit } from "@octokit/rest";
import {
	EVIDENCE_RETENTION_DAYS,
	evidenceFileName,
	evidenceRefName,
	evidenceRefPullNumber,
	evidenceUserRefPrefix,
} from "#/domain/pr-evidence";
import { githubInstallationAccessToken } from "./installation-token";

/**
 * Pull request evidence stored in the pull request's repository through the
 * Git Data API: each pull request's capture is one parentless commit under
 * `refs/ytimesy/evidence/<user>/pr-<n>`. Replacing it orphans the previous
 * capture, so history never accumulates; GitHub's own permissions decide who
 * can read it.
 */
export type EvidenceGitApi = {
	createBlob(base64: string): Promise<string>;
	createTree(entries: { path: string; sha: string }[]): Promise<string>;
	createCommit(tree: string, message: string, date: string): Promise<string>;
	setRef(ref: string, sha: string): Promise<void>;
	deleteRef(ref: string): Promise<void>;
	/** Full ref names (`refs/...`) under a prefix, with their commit dates. */
	listRefs(prefix: string): Promise<{ ref: string; sha: string }[]>;
	commitDate(sha: string): Promise<string | null>;
	openPullNumbers(): Promise<Set<number>>;
};

function repositoryParts(fullName: string) {
	const [owner, repo, ...rest] = fullName.split("/");
	if (
		rest.length ||
		!owner ||
		!repo ||
		![owner, repo].every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
	)
		throw new Error("Invalid repository.");
	return { owner, repo };
}

const status = (error: unknown) =>
	typeof error === "object" && error && "status" in error
		? Number((error as { status: unknown }).status)
		: 0;

/** The app's token for this one repository: contents write (Git objects and refs), pull requests read. */
export async function appEvidenceGitApi(
	installationId: number | string,
	fullName: string,
): Promise<EvidenceGitApi> {
	const { owner, repo } = repositoryParts(fullName);
	const token = await githubInstallationAccessToken(installationId, {
		repositoryNames: [repo],
		contents: "write",
		pullRequests: "read",
	});
	const github = new Octokit({ auth: token, request: { timeout: 30_000 } });
	return {
		async createBlob(content) {
			return (
				await github.rest.git.createBlob({
					owner,
					repo,
					content,
					encoding: "base64",
				})
			).data.sha;
		},
		async createTree(entries) {
			return (
				await github.rest.git.createTree({
					owner,
					repo,
					tree: entries.map((entry) => ({
						path: entry.path,
						sha: entry.sha,
						mode: "100644" as const,
						type: "blob" as const,
					})),
				})
			).data.sha;
		},
		async createCommit(tree, message, date) {
			const author = { name: "ytimesy", email: "noreply@ytimesy.com", date };
			return (
				await github.rest.git.createCommit({
					owner,
					repo,
					message,
					tree,
					parents: [],
					author,
					committer: author,
				})
			).data.sha;
		},
		async setRef(ref, sha) {
			try {
				await github.rest.git.updateRef({ owner, repo, ref, sha, force: true });
			} catch (error) {
				if (status(error) !== 422 && status(error) !== 404) throw error;
				await github.rest.git.createRef({
					owner,
					repo,
					ref: `refs/${ref}`,
					sha,
				});
			}
		},
		async deleteRef(ref) {
			try {
				await github.rest.git.deleteRef({ owner, repo, ref });
			} catch (error) {
				if (status(error) !== 404 && status(error) !== 422) throw error;
			}
		},
		async listRefs(prefix) {
			try {
				const refs = await github.paginate(github.rest.git.listMatchingRefs, {
					owner,
					repo,
					ref: prefix,
					per_page: 100,
				});
				return refs.map((ref) => ({ ref: ref.ref, sha: ref.object.sha }));
			} catch (error) {
				if (status(error) === 404) return [];
				throw error;
			}
		},
		async commitDate(sha) {
			try {
				return (
					await github.rest.git.getCommit({ owner, repo, commit_sha: sha })
				).data.committer.date;
			} catch (error) {
				if (status(error) === 404) return null;
				throw error;
			}
		},
		async openPullNumbers() {
			const pulls = await github.paginate(github.rest.pulls.list, {
				owner,
				repo,
				state: "open",
				per_page: 100,
			});
			return new Set(pulls.map((pull) => pull.number));
		},
	};
}

/**
 * Stores one capture as the pull request's evidence commit and returns its
 * SHA. Also removes this user's evidence for pull requests that are no
 * longer open, and captures older than the retention period.
 */
export async function publishEvidenceCommit(
	api: EvidenceGitApi,
	input: {
		userLabel: string;
		pullNumber: number;
		files: { name: string; data: Uint8Array }[];
		message: string;
		now?: Date;
	},
) {
	const now = input.now ?? new Date();
	const entries: { path: string; sha: string }[] = [];
	for (const file of input.files) {
		if (!evidenceFileName(file.name))
			throw new Error(`Refusing to store ${file.name}.`);
		entries.push({
			path: file.name,
			sha: await api.createBlob(Buffer.from(file.data).toString("base64")),
		});
	}
	const tree = await api.createTree(entries);
	const commit = await api.createCommit(
		tree,
		`${input.message}\n\n[skip ci]`,
		now.toISOString(),
	);
	await api.setRef(evidenceRefName(input.userLabel, input.pullNumber), commit);
	await pruneEvidenceRefs(api, input.userLabel, {
		now,
		keep: input.pullNumber,
	}).catch(() => undefined);
	return commit;
}

/** Deletes this user's evidence for closed pull requests and captures past retention. */
export async function pruneEvidenceRefs(
	api: EvidenceGitApi,
	userLabel: string,
	options: { now?: Date; keep?: number } = {},
) {
	const now = options.now ?? new Date();
	const refs = await api.listRefs(evidenceUserRefPrefix(userLabel));
	if (!refs.length) return [];
	const open = await api.openPullNumbers();
	const removed: string[] = [];
	for (const { ref, sha } of refs) {
		const number = evidenceRefPullNumber(ref, userLabel);
		if (number === null || number === options.keep) continue;
		const date = open.has(number) ? await api.commitDate(sha) : null;
		const expired =
			!open.has(number) ||
			!date ||
			now.getTime() - Date.parse(date) >
				EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		if (!expired) continue;
		await api.deleteRef(ref.slice("refs/".length));
		removed.push(ref);
	}
	return removed;
}

/** Removes every evidence ref this user has in the repository (project or account deletion). */
export async function deleteUserEvidenceRefs(
	api: EvidenceGitApi,
	userLabel: string,
) {
	const refs = await api.listRefs(evidenceUserRefPrefix(userLabel));
	for (const { ref } of refs)
		if (evidenceRefPullNumber(ref, userLabel) !== null)
			await api.deleteRef(ref.slice("refs/".length));
	return refs.length;
}
