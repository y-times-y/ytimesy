import { fileBasename } from "#/domain/file-kind";
import type { FileChangeEntry } from "#/domain/session-item";
import { FileTypeIcon } from "./file-type-icon";

export function FileChangeRow({ change }: { change: FileChangeEntry }) {
	const name = fileBasename(change.path);
	return (
		<li className="file-change-row" data-change={change.change}>
			<FileTypeIcon path={change.path} />
			<span className="file-change-path" title={change.path}>
				<span className="file-change-name">{name}</span>
				{name !== change.path ? (
					<span className="file-change-dir">{change.path}</span>
				) : null}
			</span>
			<span className="file-change-stats">
				<span className="file-change-additions">+{change.additions}</span>
				<span className="file-change-deletions">-{change.deletions}</span>
			</span>
		</li>
	);
}

export function FileChangeList({
	changes,
	label = "File changes",
}: {
	changes: readonly FileChangeEntry[];
	label?: string;
}) {
	if (changes.length === 0) return null;
	return (
		<ul className="file-change-list" aria-label={label}>
			{changes.map((change) => (
				<FileChangeRow
					key={`${change.change}:${change.path}`}
					change={change}
				/>
			))}
		</ul>
	);
}
