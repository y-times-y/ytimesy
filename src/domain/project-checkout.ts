export type ProjectCheckout = {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly branch: string;
	readonly workingBranch: string;
	readonly installationId: string;
	readonly additionalRepositories?: ProjectCheckout[];
	readonly preserveCurrentBranch?: boolean;
	readonly retainExistingBranch?: boolean;
};

export function projectCheckoutPath(home: string, repoName: string): string {
	const root = home.replace(/\/+$/, "") || "/home/ubuntu";
	return `${root}/${repoName}`;
}

export function projectCheckoutFromFullName(input: {
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
		owner,
		name,
		fullName: input.fullName,
		branch: input.branch,
		workingBranch: input.workingBranch?.trim() || input.branch,
		installationId: String(input.installationId),
	};
}
