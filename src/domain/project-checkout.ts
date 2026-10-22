export type ProjectCheckout = {
	readonly userId?: string;
	readonly projectId?: string;
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly branch: string;
	readonly workingBranch: string;
	readonly installationId: string;
	readonly additionalRepositories?: ProjectCheckout[];
	readonly preserveCurrentBranch?: boolean;
	readonly retainExistingBranch?: boolean;
	/**
	 * The commit the checkout and its baseline must land on, resolved before
	 * the VM was ready (a new chat's early first request decided on it).
	 */
	readonly pinnedRevision?: string;
};

export function projectCheckoutPath(home: string, repoName: string): string {
	const root = home.replace(/\/+$/, "") || "/home/ubuntu";
	return `${root}/${repoName}`;
}

export function projectCheckoutFromFullName(input: {
	readonly userId?: string;
	readonly projectId?: string;
	readonly fullName: string;
	readonly branch: string;
	readonly workingBranch?: string;
	readonly installationId: string | number;
}): ProjectCheckout | null {
	const slash = input.fullName.indexOf("/");
	if (slash <= 0 || slash !== input.fullName.lastIndexOf("/")) return null;
	const owner = input.fullName.slice(0, slash);
	const name = input.fullName.slice(slash + 1);
	if (!owner || !name) return null;
	return {
		...(input.userId ? { userId: input.userId } : {}),
		...(input.projectId ? { projectId: input.projectId } : {}),
		owner,
		name,
		fullName: input.fullName,
		branch: input.branch,
		workingBranch: input.workingBranch?.trim() || input.branch,
		installationId: String(input.installationId),
	};
}
