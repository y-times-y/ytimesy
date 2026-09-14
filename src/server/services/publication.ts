import { Effect } from "effect";
import { publicationBlockedReason } from "../../domain/publication";
import {
	authorizedRepository,
	compareBranchAhead,
	createDraftPullRequest,
} from "../adapters/github";
import { projectForOwner } from "../adapters/projects";
import { githubAccessToken } from "../auth/github-connection";

/**
 * Opens a draft PR from the project's branch. Does not commit or push; the
 * workspace host has to put commits on GitHub first.
 */
export function publishProject(
	userId: string,
	input: { projectId: string; title: string; body?: string },
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const project = yield* Effect.tryPromise(async () => {
			const owned = await projectForOwner(userId, input.projectId);
			if (!owned)
				throw new Response("Project is not available.", { status: 404 });
			return owned;
		});
		const repository = yield* Effect.tryPromise(() =>
			authorizedRepository(token, project.installationId, project.repositoryId),
		);
		const aheadBy = yield* Effect.tryPromise(() =>
			compareBranchAhead(
				token,
				repository.fullName,
				repository.defaultBranch,
				project.branch,
			),
		);
		yield* Effect.tryPromise(async () => {
			const blocked = publicationBlockedReason({
				head: project.branch,
				base: repository.defaultBranch,
				aheadBy,
			});
			if (blocked) throw new Response(blocked, { status: 409 });
		});
		return yield* Effect.tryPromise(() =>
			createDraftPullRequest(token, repository.fullName, {
				title: input.title,
				body: input.body ?? "",
				head: project.branch,
				base: repository.defaultBranch,
			}),
		);
	});
}
