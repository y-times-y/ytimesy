export function FileChangeCounts({
	additions,
	deletions,
}: {
	additions: number;
	deletions: number;
}) {
	return (
		<span className="file-change-stats">
			<span className="file-change-additions">+{additions}</span>
			<span className="file-change-deletions">-{deletions}</span>
		</span>
	);
}
