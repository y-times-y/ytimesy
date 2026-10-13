import { AuthSnapshotId, type WorkspaceId } from "./ids";

export type IsolatedAuthSnapshot = {
	readonly snapshotId: AuthSnapshotId;
	readonly sourceWorkspaceId: WorkspaceId;
	readonly public: false;
};

export function isolatedAuthSnapshot(input: {
	readonly snapshotId: string;
	readonly sourceWorkspaceId: WorkspaceId;
	readonly public: boolean;
}): IsolatedAuthSnapshot {
	if (input.public) {
		throw new Error(
			"Credential snapshots must stay private; shared base images cannot contain user secrets",
		);
	}
	return {
		snapshotId: AuthSnapshotId(input.snapshotId),
		sourceWorkspaceId: input.sourceWorkspaceId,
		public: false,
	};
}
