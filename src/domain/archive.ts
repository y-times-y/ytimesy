/** Days an archived chat or project is kept before it is deleted for good. */
export const ARCHIVE_RETENTION_DAYS = 30;

export type ArchivedKind = "chat" | "project";

export type ArchivedItem = {
	readonly kind: ArchivedKind;
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	/** The chat's project, for an archived chat. */
	readonly projectName: string | null;
	readonly archivedAt: string;
};

/** Whole days left before an archived item is deleted; 0 on its last day. */
export function archiveDaysLeft(archivedAt: string, nowMs: number): number {
	const ends = Date.parse(archivedAt) + ARCHIVE_RETENTION_DAYS * 86_400_000;
	return Math.max(0, Math.floor((ends - nowMs) / 86_400_000));
}
