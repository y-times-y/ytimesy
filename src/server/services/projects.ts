import { Effect } from "effect";
import type { ProjectSelection } from "../../domain/projects";
import { authorizedRepository, githubClient } from "../adapters/github";
import { saveProject } from "../adapters/projects";
import { githubAccessToken } from "../auth/github-connection";
import { enqueueProjectWorkspace } from "./workspaces";

export function connectProject(
	userId: string,
	selection: ProjectSelection,
	enqueue = enqueueProjectWorkspace,
) {
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
		const project = yield* Effect.tryPromise(() =>
			saveProject(userId, repository, selection.branch),
		);
		yield* enqueue(userId, project.id);
		return project;
	});
}
