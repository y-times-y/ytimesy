export type GitHubRepository = {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
	readonly installationId: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
