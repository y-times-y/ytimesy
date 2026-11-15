import { z } from "zod";
import { authorizedRepository } from "../adapters/github";
import { repositoryAccess } from "../adapters/github/repository-access-cache";
import { requireUser } from "../auth/auth";
import { githubAccessToken } from "../auth/github-connection";
import { timed } from "./step-timing";

export const repositorySelection = z.object({
	installationId: z.coerce.number().int().positive().safe(),
	repositoryId: z.coerce.number().int().positive().safe(),
});

/**
 * The signed-in user's token and the repository's name. Reads reuse a
 * confirmed access for a minute (repository-access-cache.ts); changes always
 * ask GitHub again.
 */
export async function githubRepositoryFor(
	request: Request,
	params: z.infer<typeof repositorySelection>,
	{ reuseAccess }: { reuseAccess: boolean },
) {
	const user = await requireUser(request.headers);
	const token = await timed("github:token", () => githubAccessToken(user.id));
	const key = { userId: user.id, ...params };
	const check = () =>
		authorizedRepository(token, params.installationId, params.repositoryId);
	const repository = await timed("github:authorize", () =>
		reuseAccess ? repositoryAccess.access(key, check) : check(),
	);
	return {
		token,
		fullName: repository.fullName,
		/** GitHub refused the token for this repository: check again next time. */
		refused: repositoryAccess.refused(key),
	};
}
