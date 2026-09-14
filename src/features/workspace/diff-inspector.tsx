import { useState } from "react";
import { diffPreviewLines } from "#/domain/diff-preview";
import {
	fileChangeDisplayPath,
	fileChangesHeading,
} from "#/domain/file-change-copy";
import type { FileChangeEntry } from "#/domain/session-item";
import { FileChangeCounts } from "../sessions/file-change-counts";

export function DiffInspector({
	changes,
}: {
	changes: readonly FileChangeEntry[];
}) {
	const heading = fileChangesHeading(changes);
	return (
		<section className="diff-inspector" aria-label="Code changes">
			<header className="diff-inspector-header">
				<span>{heading.label}</span>
				<FileChangeCounts
					additions={heading.additions}
					deletions={heading.deletions}
				/>
			</header>
			<ul className="diff-file-list">
				{changes.map((change, index) => (
					<li key={`${change.change}:${change.path}`}>
						<DiffFilePreview change={change} defaultOpen={index === 0} />
					</li>
				))}
			</ul>
		</section>
	);
}

function DiffFilePreview({
	change,
	defaultOpen,
}: {
	change: FileChangeEntry;
	defaultOpen: boolean;
}) {
	const path = fileChangeDisplayPath(change.path);
	const lines = diffPreviewLines(change);
	const [open, setOpen] = useState(defaultOpen);
	return (
		<details
			className="diff-file"
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary title={change.path}>
				<span className="file-change-name">{path}</span>
				<FileChangeCounts
					additions={change.additions}
					deletions={change.deletions}
				/>
			</summary>
			{lines.length === 0 ? (
				<p className="diff-preview-empty">No diff preview for this file.</p>
			) : (
				<pre className="diff-preview">
					{lines.map((line) => (
						<span
							key={`${change.path}:${line.number}`}
							className={`diff-line diff-line-${line.kind}`}
						>
							<span className="diff-gutter" aria-hidden="true">
								{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
							</span>
							{line.text}
						</span>
					))}
				</pre>
			)}
		</details>
	);
}
