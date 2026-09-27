import { workspaceSourcePath } from "./workspace-explorer";

export type ProjectFileRoot = { name: string; directory: string };

/** Multi-repository paths carry a repository prefix; legacy paths stay relative. */
export function resolveProjectFile(
	roots: readonly ProjectFileRoot[],
	requested: string,
) {
	if (!roots.length) return null;
	const selected =
		roots.find(
			(root) =>
				requested.startsWith(`${root.name}/`) ||
				requested.startsWith(`${root.directory}/`),
		) || roots[0];
	const relative =
		roots.length > 1 && requested.startsWith(`${selected.name}/`)
			? requested.slice(selected.name.length + 1)
			: requested;
	const path = workspaceSourcePath(selected.directory, relative);
	return path
		? {
				root: selected.directory,
				path,
				relative: path.slice(selected.directory.length + 1),
			}
		: null;
}
