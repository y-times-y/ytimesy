import { Effect } from "effect";
import type { ProjectSelection } from "../../domain/projects";
import { authorizedRepository, githubClient } from "../adapters/github";
import { saveProject } from "../adapters/projects";
import { githubAccessToken } from "../auth/github-connection";

export function connectProject(userId: string, selection: ProjectSelection) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const repository = yield* Effect.tryPromise(() =>
			authorizedRepository(
				token,
				selection.installationId,
				selection.repositoryId,
			),
		);
		const [owner, repo] = repository.fullName.split("/");
		yield* Effect.tryPromise(() =>
			githubClient(token).repos.getBranch({
				owner,
				repo,
				branch: selection.branch,
			}),
		);
		return yield* Effect.tryPromise(() =>
			saveProject(userId, repository, selection.branch),
		);
	});
}
