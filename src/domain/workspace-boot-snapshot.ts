export function workspaceBootSnapshotId(input: {
	readonly userAuthSnapshotId: string | null | undefined;
	readonly toolsSnapshotId: string | null | undefined;
}): string | undefined {
	const user = input.userAuthSnapshotId?.trim();
	if (user) return user;
	const tools = input.toolsSnapshotId?.trim();
	return tools || undefined;
}

export function toolsSnapshotIdFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim() || undefined;
}
