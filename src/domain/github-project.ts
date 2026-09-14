import { ProjectId } from "./ids";

const GITHUB_PROJECT_ID = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export type GitHubRepository = {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
	readonly installationId: string;
};

export type ListedGitHubProject = {
	readonly projectId: ProjectId;
	readonly repository: GitHubRepository;
};

export type SelectedGitHubProject = {
	readonly projectId: ProjectId;
	readonly branch: string;
};

export type GitHubProjectCatalog =
	| { readonly status: "unconfigured"; readonly message: string }
	| { readonly status: "no_installations"; readonly installUrl: string | null }
	| { readonly status: "no_repositories"; readonly installUrl: string | null }
	| {
			readonly status: "failed";
			readonly message: string;
			readonly installUrl: string | null;
	  }
	| {
			readonly status: "ready";
			readonly projects: readonly ListedGitHubProject[];
			readonly installUrl: string | null;
	  };

export type PublicGitHubProject = {
	readonly projectId: string;
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
};

export type PublicProjectPicker = {
	readonly status: GitHubProjectCatalog["status"];
	readonly projects: readonly PublicGitHubProject[];
	readonly selectedProjectId: string | null;
	readonly selectedBranch: string | null;
	readonly branches: readonly string[];
	readonly installUrl: string | null;
	readonly message: string | null;
};

export function githubProjectId(fullName: string): ProjectId {
	const trimmed = fullName.trim();
	const slash = trimmed.indexOf("/");
	if (
		slash <= 0 ||
		slash !== trimmed.lastIndexOf("/") ||
		slash === trimmed.length - 1
	) {
		throw new Error("GitHub repository full name must be owner/name");
	}
	return ProjectId(`github:${trimmed}`);
}

export function parseGitHubProjectId(
	projectId: ProjectId,
): { owner: string; name: string } | null {
	const match = GITHUB_PROJECT_ID.exec(projectId);
	if (!match) return null;
	return { owner: match[1], name: match[2] };
}

export function gitHubRepositoryFromApi(
	installationId: string,
	value: unknown,
): GitHubRepository | null {
	if (!isRecord(value)) return null;
	const ownerValue = value.owner;
	const owner =
		isRecord(ownerValue) && typeof ownerValue.login === "string"
			? ownerValue.login.trim()
			: "";
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const fullName =
		typeof value.full_name === "string"
			? value.full_name.trim()
			: owner && name
				? `${owner}/${name}`
				: "";
	const defaultBranch =
		typeof value.default_branch === "string" ? value.default_branch.trim() : "";
	if (
		!owner ||
		!name ||
		!fullName ||
		!defaultBranch ||
		!installationId.trim()
	) {
		return null;
	}
	return {
		owner,
		name,
		fullName,
		defaultBranch,
		private: value.private === true,
		installationId: installationId.trim(),
	};
}

export function listedGitHubProject(
	repository: GitHubRepository,
): ListedGitHubProject {
	return {
		projectId: githubProjectId(repository.fullName),
		repository,
	};
}

export function githubAppInstallUrl(slug: string): string {
	const cleaned = slug.trim();
	if (!cleaned) throw new Error("GitHub App slug is required");
	return `https://github.com/apps/${cleaned}/installations/new`;
}

export function gitHubProjectCatalog(input: {
	credentialsPresent: boolean;
	installUrl: string | null;
	installationCount: number;
	repositories: readonly GitHubRepository[];
	error?: string;
}): GitHubProjectCatalog {
	if (input.error) {
		return {
			status: "failed",
			message: input.error,
			installUrl: input.installUrl,
		};
	}
	if (!input.credentialsPresent) {
		return {
			status: "unconfigured",
			message: "GitHub App credentials are not configured.",
		};
	}
	if (input.installationCount === 0) {
		return { status: "no_installations", installUrl: input.installUrl };
	}
	if (input.repositories.length === 0) {
		return { status: "no_repositories", installUrl: input.installUrl };
	}
	return {
		status: "ready",
		projects: input.repositories.map(listedGitHubProject),
		installUrl: input.installUrl,
	};
}

export function catalogStatusCopy(
	catalog: GitHubProjectCatalog,
): string | null {
	switch (catalog.status) {
		case "unconfigured":
			return catalog.message;
		case "no_installations":
			return "Install the GitHub App to add a project.";
		case "no_repositories":
			return "No repositories granted to the GitHub App.";
		case "failed":
			return catalog.message;
		case "ready":
			return null;
	}
}

export function resolveSelectedProject(input: {
	projects: readonly ListedGitHubProject[];
	saved: SelectedGitHubProject | null;
}): SelectedGitHubProject | null {
	if (input.saved) {
		const match = input.projects.find(
			(project) => project.projectId === input.saved?.projectId,
		);
		if (match) {
			return {
				projectId: match.projectId,
				branch: input.saved.branch.trim() || match.repository.defaultBranch,
			};
		}
	}
	if (input.projects.length !== 1) return null;
	const only = input.projects[0];
	return {
		projectId: only.projectId,
		branch: only.repository.defaultBranch,
	};
}

export function branchesForPicker(
	branches: readonly string[],
	defaultBranch: string,
): readonly string[] {
	const names = [
		...new Set(branches.map((branch) => branch.trim()).filter(Boolean)),
	];
	if (defaultBranch && !names.includes(defaultBranch)) {
		names.unshift(defaultBranch);
	}
	return names;
}

export function resolveSelectedBranch(
	selected: SelectedGitHubProject,
	branches: readonly string[],
	defaultBranch: string,
): string {
	if (branches.includes(selected.branch)) return selected.branch;
	if (branches.includes(defaultBranch)) return defaultBranch;
	return selected.branch || defaultBranch;
}

export function selectionNeedsPersist(
	saved: SelectedGitHubProject | null,
	resolved: SelectedGitHubProject | null,
): boolean {
	if (!resolved) return saved !== null;
	if (!saved) return true;
	return (
		saved.projectId !== resolved.projectId || saved.branch !== resolved.branch
	);
}

export function publicProjectPicker(input: {
	catalog: GitHubProjectCatalog;
	selected: SelectedGitHubProject | null;
	branches: readonly string[];
}): PublicProjectPicker {
	const projects =
		input.catalog.status === "ready"
			? input.catalog.projects.map((project) => ({
					projectId: project.projectId,
					fullName: project.repository.fullName,
					defaultBranch: project.repository.defaultBranch,
					private: project.repository.private,
				}))
			: [];
	const installUrl =
		input.catalog.status === "unconfigured" ? null : input.catalog.installUrl;
	return {
		status: input.catalog.status,
		projects,
		selectedProjectId: input.selected?.projectId ?? null,
		selectedBranch: input.selected?.branch ?? null,
		branches: input.branches,
		installUrl,
		message: catalogStatusCopy(input.catalog),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
