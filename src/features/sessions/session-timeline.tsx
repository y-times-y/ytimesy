import {
	Brain,
	Files,
	Globe,
	SquareTerminal,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";

export function SessionTimeline({
	items,
	turnStatus,
	fill = false,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	fill?: boolean;
}) {
	const listRef = useRef<HTMLOListElement>(null);

	useEffect(() => {
		listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
	});

	if (items.length === 0 && turnStatus !== "running" && !fill) return null;

	return (
		<ol ref={listRef} className="session-timeline" aria-label="Session">
			<li className="session-timeline-spacer" aria-hidden="true" />
			{items.map((item) => (
				<li key={item.id} data-kind={item.kind}>
					<SessionItemView item={item} />
				</li>
			))}
			{turnStatus === "running" ? (
				<li data-kind="working">
					<p className="session-working">Working…</p>
				</li>
			) : null}
		</ol>
	);
}

function SessionItemView({ item }: { item: SessionItem }) {
	switch (item.kind) {
		case "userMessage":
			return <ConversationBlock text={item.text} speaker="user" />;
		case "agentMessage":
			return <ConversationBlock text={item.text} speaker="assistant" />;
		case "reasoning":
			return (
				<details className="session-activity" data-kind="reasoning">
					<summary>
						<Brain size={16} />
						<span className="session-activity-title">
							{item.summaries[0] ?? "Thinking"}
						</span>
					</summary>
					{item.summaries.slice(item.summaries[0] ? 1 : 0).map((summary) => (
						<p key={`${item.id}:${summary}`}>{summary}</p>
					))}
				</details>
			);
		case "plan":
			return (
				<details className="session-activity" data-kind="plan" open>
					<summary>
						<Brain size={16} />
						<span className="session-activity-title">Plan</span>
					</summary>
					<p>{item.text || "Planning…"}</p>
				</details>
			);
		case "commandExecution":
			return (
				<details
					className="session-activity"
					data-kind="commandExecution"
					data-status={item.status}
					open={item.status === "inProgress" || Boolean(item.output)}
				>
					<summary>
						<SquareTerminal size={16} />
						<code className="session-activity-title">{item.command}</code>
						<span className="session-activity-status">
							{activityStatusLabel(item.status)}
						</span>
					</summary>
					{item.cwd ? (
						<p className="session-activity-meta">{item.cwd}</p>
					) : null}
					{item.output ? (
						<pre className="session-output">{item.output}</pre>
					) : null}
					{item.exitCode !== null ? (
						<p className="session-activity-meta">exit {item.exitCode}</p>
					) : null}
				</details>
			);
		case "fileChange":
			return (
				<div
					className="session-activity"
					data-kind="fileChange"
					data-status={item.status}
				>
					<p>
						<Files size={16} />
						<span className="session-activity-title">Files</span>
						<span className="session-activity-status">
							{activityStatusLabel(item.status)}
						</span>
					</p>
					<ul>
						{item.changes.map((change) => (
							<li key={`${change.change}:${change.path}`}>
								{change.change} {change.path}
							</li>
						))}
					</ul>
				</div>
			);
		case "mcpToolCall":
			return (
				<div
					className="session-activity"
					data-kind="mcpToolCall"
					data-status={item.status}
				>
					<p>
						<Wrench size={16} />
						<span className="session-activity-title">
							{item.server} · {item.tool}
						</span>
						<span className="session-activity-status">
							{activityStatusLabel(item.status)}
						</span>
					</p>
				</div>
			);
		case "dynamicToolCall":
			return (
				<div
					className="session-activity"
					data-kind="dynamicToolCall"
					data-status={item.status}
				>
					<p>
						<Wrench size={16} />
						<span className="session-activity-title">{item.tool}</span>
						<span className="session-activity-status">
							{activityStatusLabel(item.status)}
						</span>
					</p>
				</div>
			);
		case "webSearch":
			return (
				<div className="session-activity" data-kind="webSearch">
					<p>
						<Globe size={16} />
						<span className="session-activity-title">
							{item.query ? item.query : "Search"}
						</span>
					</p>
				</div>
			);
		case "error":
			return (
				<div className="session-activity" data-kind="error" role="alert">
					<p>
						<TriangleAlert size={16} />
						<span className="session-activity-title">{item.message}</span>
					</p>
				</div>
			);
		case "unknown":
			return (
				<div className="session-activity" data-kind="unknown">
					<p>
						<Wrench size={16} />
						<span className="session-activity-title">{item.type}</span>
					</p>
				</div>
			);
	}
}

function ConversationBlock({
	text,
	speaker,
}: {
	text: string;
	speaker: "user" | "assistant";
}) {
	return (
		<div className="session-message" data-role={speaker}>
			<p>{text}</p>
		</div>
	);
}

function activityStatusLabel(status: string): string {
	if (status === "inProgress") return "Running";
	if (status === "completed") return "Done";
	if (status === "failed") return "Failed";
	if (status === "declined") return "Declined";
	return status;
}
