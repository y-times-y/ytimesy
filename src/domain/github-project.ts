import { ProjectId } from "./ids";

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

export function githubRepositoryName(fullName: string): string {
	const parsed = fullName.trim().split("/");
	return parsed.length === 2 && parsed[1] ? parsed[1] : fullName.trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
