import { ChevronRight } from "lucide-react";
import {
	handoffCardLabel,
	handoffCardMeta,
	LOCAL_AGENT_NAMES,
} from "#/domain/local-import-view";
import type { HandoffSessionItem } from "#/domain/session-item";
import { LocalAgentMark } from "./local-agent-mark";
import "./handoff-card.css";

/** Rows a details list shows before "+N more". */
const LISTED = 30;

function FileList({
	label,
	files,
	total,
}: {
	label: string;
	files: readonly string[];
	total: number;
}) {
	if (!total) return null;
	const shown = files.slice(0, LISTED);
	const more = total - shown.length;
	return (
		<div className="handoff-card-group">
			<span className="handoff-card-group-label">
				{label} ({total})
			</span>
			<ul>
				{shown.map((file) => (
					<li key={file} title={file}>
						{file}
					</li>
				))}
				{more > 0 ? <li className="handoff-card-more">+{more} more</li> : null}
			</ul>
		</div>
	);
}

/**
 * The first item of a chat continued from a local agent session: where it
 * came from, then at most three short lines (goal, where it stopped, next)
 * and the turns, date and the chat's branch (the local one is in the
 * details). Files, commands and the transcript's path sit in a closed fold, so the card paints the same on the server and in the
 * browser. Chats imported before the summary existed keep the one line.
 */
export function HandoffCard({ item }: { item: HandoffSessionItem }) {
	const summary = item.summary;
	const tooltip = `${item.title || "Untitled session"}. The agent has this conversation; full transcripts are on its machine in ~/.ytimesy/handoff/.`;
	if (!summary)
		return (
			<div
				className="session-activity session-system-notice session-handoff"
				data-kind="handoff"
				role="status"
			>
				<p>
					<span className="session-handoff-mark" aria-hidden="true">
						<LocalAgentMark agent={item.tool} size={14} />
					</span>
					<span className="session-activity-title" title={tooltip}>
						{handoffCardLabel(item)}
					</span>
				</p>
			</div>
		);
	const lines = [
		{ label: "Goal", text: summary.goal },
		{ label: "Stopped", text: summary.stopped },
		{ label: "Next", text: summary.next },
	].filter((line): line is { label: string; text: string } =>
		Boolean(line.text),
	);
	const files = item.files;
	return (
		<section
			className="handoff-card"
			data-kind="handoff"
			aria-label={`Continued from ${LOCAL_AGENT_NAMES[item.tool] ?? item.tool}`}
		>
			<p className="handoff-card-head">
				<span className="session-handoff-mark" aria-hidden="true">
					<LocalAgentMark agent={item.tool} size={16} />
				</span>
				<span title={tooltip}>
					Continued from {LOCAL_AGENT_NAMES[item.tool] ?? item.tool}
				</span>
			</p>
			{lines.length ? (
				<dl className="handoff-card-lines">
					{lines.map((line) => (
						<div key={line.label}>
							<dt>{line.label}</dt>
							<dd title={line.text}>{line.text}</dd>
						</div>
					))}
				</dl>
			) : null}
			<details className="handoff-card-details">
				<summary>
					<span className="handoff-card-meta">
						{handoffCardMeta({
							turns: item.turns,
							at: item.at,
							// The chat's own branch; the local one shows in the details.
							branch: item.branch,
						})}
					</span>
					<span className="handoff-card-toggle">
						Details
						<ChevronRight size={12} aria-hidden="true" />
					</span>
				</summary>
				<div className="handoff-card-body">
					<FileList
						label="Edited"
						files={summary.edited}
						total={summary.editedCount}
					/>
					<FileList
						label="Commands that worked"
						files={summary.commands}
						total={summary.commands.length}
					/>
					{files ? (
						<>
							<FileList
								label="Pushed"
								files={files.pushed}
								total={files.pushedCount}
							/>
							<FileList
								label="Skipped"
								files={files.skipped}
								total={files.skippedCount}
							/>
						</>
					) : null}
					{item.branch || summary.localBranch ? (
						<div className="handoff-card-group">
							<span className="handoff-card-group-label">Branch</span>
							<span className="handoff-card-branch">
								{item.branch ? <code>{item.branch}</code> : null}
								{summary.localBranch ? (
									<small>from {summary.localBranch}</small>
								) : null}
							</span>
						</div>
					) : null}
					<div className="handoff-card-group">
						<span className="handoff-card-group-label">Transcript</span>
						<code>{summary.transcript}</code>
					</div>
				</div>
			</details>
		</section>
	);
}
