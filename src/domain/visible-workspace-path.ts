export function visibleWorkspacePath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
	const withoutHome = normalized.replace(/^\/home\/[^/]+\//, "");
	return withoutHome.replace(/^\//, "") || path;
}
