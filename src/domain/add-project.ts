import {
	type Project,
	type RepositoryChoice,
	repositoriesForProject,
} from "./projects";

type AddProjectPhase = "loading" | "connect" | "choose" | "retry";

/** Shown when the repository list request died in the browser, not when GitHub refused. */
export const GITHUB_LIST_UNREACHABLE = "Couldn't reach GitHub.";

export function addProjectPhase(input: {
	readonly loading: boolean;
	readonly githubReady: boolean;
	/** The list request never got a response. Not a reason to ask for a new connection. */
	readonly unreachable?: boolean;
}): AddProjectPhase {
	if (input.loading) return "loading";
	if (!input.githubReady && input.unreachable) return "retry";
	if (!input.githubReady) return "connect";
	return "choose";
}

export function addProjectCopy(phase: AddProjectPhase) {
	if (phase === "connect") {
		return {
			title: "Connect GitHub",
			description:
				"Grant ytimesy access to the repositories you want to work on.",
		};
	}
	if (phase === "retry") {
		return {
			title: "GitHub",
			description: GITHUB_LIST_UNREACHABLE,
		};
	}
	return {
		title: "Add project",
		description: "Select repositories to share one project environment.",
	};
}

/** Empty-state copy for the repository list beside the composer. */
export function githubRepositoryListMessage(input: {
	readonly query: string;
	readonly loaded: boolean;
	readonly unreachable: boolean;
	readonly errorMessage?: string;
}): string {
	if (input.query.trim()) return "No repositories match.";
	if (input.loaded) return "Every repository is already a project.";
	if (input.unreachable) return GITHUB_LIST_UNREACHABLE;
	return input.errorMessage || "Connect GitHub to see repositories.";
}

export function addedProjectBranch(
	repository: Pick<
		RepositoryChoice,
		"fullName" | "repositoryId" | "defaultBranch"
	>,
) {
	return repository.defaultBranch;
}

export function filterRepositories(
	repositories: readonly RepositoryChoice[],
	query: string,
): RepositoryChoice[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...repositories];
	return repositories.filter((repository) =>
		repository.fullName.toLowerCase().includes(needle),
	);
}

export function repositoryChoiceValue(repository: RepositoryChoice) {
	return `${repository.installationId}:${repository.repositoryId}`;
}

function filterProjects(
	projects: readonly Project[],
	query: string,
): Project[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...projects];
	return projects.filter((project) =>
		[
			project.name,
			project.fullName,
			...(project.repositories?.map((repo) => repo.fullName) ?? []),
		].some((name) => name?.toLowerCase().includes(needle)),
	);
}

export function scratchRepositoryName(value: string) {
	const name = value.trim();
	return /^[A-Za-z0-9_.-]{1,100}$/.test(name) ? name : null;
}

/** The project that already holds exactly this one repository, named or not.
 * Adding the same repository again reuses it instead of creating a duplicate. */
export function singleRepositoryProject(
	projects: readonly Project[],
	repositoryId: number,
): Project | undefined {
	return projects.find((project) => {
		const repositories = repositoriesForProject(project);
		return (
			repositories.length === 1 &&
			repositories[0]?.repositoryId === repositoryId
		);
	});
}

type ProjectPickerRow = {
	readonly key: string;
	readonly fullName: string;
	readonly selected: boolean;
	readonly project?: Project;
	readonly repository?: RepositoryChoice;
};

export function projectPickerRows(input: {
	readonly projects: readonly Project[];
	readonly repositories: readonly RepositoryChoice[];
	readonly query: string;
	readonly selectedProjectId?: string;
}): ProjectPickerRow[] {
	const claimed = new Set<string>();
	const rows: ProjectPickerRow[] = [];
	for (const repository of filterRepositories(
		input.repositories,
		input.query,
	)) {
		const project = singleRepositoryProject(
			input.projects,
			repository.repositoryId,
		);
		if (project) claimed.add(project.id);
		rows.push({
			key: repositoryChoiceValue(repository),
			fullName: project?.name || repository.fullName,
			selected: Boolean(project) && project?.id === input.selectedProjectId,
			project,
			repository,
		});
	}
	for (const project of filterProjects(input.projects, input.query)) {
		if (claimed.has(project.id)) continue;
		rows.push({
			key: project.id,
			fullName: project.name || project.fullName,
			selected: project.id === input.selectedProjectId,
			project,
		});
	}
	return rows.sort((left, right) =>
		left.fullName.localeCompare(right.fullName),
	);
}

/** Picker sections that never reshuffle while repositories load: added projects
 * first (the selected one pinned on top), then GitHub repositories not yet added. */
export function projectPickerSections(input: {
	readonly projects: readonly Project[];
	readonly repositories: readonly RepositoryChoice[];
	readonly query: string;
	readonly selectedProjectId?: string;
}) {
	const rows = projectPickerRows(input);
	return {
		projects: rows
			.filter((row) => row.project)
			.sort((left, right) => Number(right.selected) - Number(left.selected)),
		repositories: rows.filter((row) => !row.project),
	};
}
