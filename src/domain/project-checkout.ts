export type ProjectCheckout = {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly branch: string;
	readonly installationId: string;
};

export function projectCheckoutPath(home: string, repoName: string): string {
	const root = home.replace(/\/+$/, "") || "/home/ubuntu";
	return `${root}/${repoName}`;
}
