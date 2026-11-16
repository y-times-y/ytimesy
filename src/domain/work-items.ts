import {
	type Project,
	projectFolderName,
	repositoriesForProject,
} from "./projects";

/** A repository connected to at least one project, as the Pull requests and Issues pages list it. */
export type ConnectedRepository = {
	readonly installationId: number;
	readonly repositoryId: number;
	/** The repository's name; the owner too when two connected repositories share a name. */
	readonly name: string;
	/** The first project that has it: chats started from the pages belong there. */
	readonly projectId: string;
};

/**
 * Every repository connected to any project, once each (two projects on one
 * repository list it once), in project order. Never repositories on GitHub the
 * user has not added.
 */
export function connectedRepositories(
	projects: readonly Project[],
): ConnectedRepository[] {
	const seen = new Set<number>();
	const found: { fullName: string; repository: ConnectedRepository }[] = [];
	for (const project of projects)
		for (const repository of repositoriesForProject(project)) {
			if (
				!repository.repositoryId ||
				!repository.installationId ||
				seen.has(repository.repositoryId)
			)
				continue;
			seen.add(repository.repositoryId);
			found.push({
				fullName: repository.fullName,
				repository: {
					installationId: repository.installationId,
					repositoryId: repository.repositoryId,
					name: projectFolderName(repository.fullName),
					projectId: project.id,
				},
			});
		}
	const names = new Map<string, number>();
	for (const { repository } of found)
		names.set(repository.name, (names.get(repository.name) ?? 0) + 1);
	return found.map(({ fullName, repository }) =>
		(names.get(repository.name) ?? 0) > 1
			? { ...repository, name: fullName }
			: repository,
	);
}

/** How many rows of the lists are waiting on the signed-in user: the sidebar badge. */
export function waitingCount(
	lists: readonly ({ readonly waiting?: boolean }[] | null | undefined)[],
): number {
	let count = 0;
	for (const list of lists)
		for (const item of list ?? []) if (item.waiting) count += 1;
	return count;
}
