import { ChevronRight, GitPullRequest } from "lucide-react";
import type { AgentTask } from "#/domain/agent-task";
import { fileChangeTotals } from "#/domain/diff-preview";
import type { FileChangeEntry, SessionItem } from "#/domain/session-item";
import {
	type ListedPullRequest,
	sidebarChatPrNeedFromPullRequest,
	sidebarChatPrNeedLabel,
} from "#/domain/sidebar-pr";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { AgentMarkdown } from "../sessions/agent-markdown";
import { TaskPanel } from "../sessions/task-panel";
import { TodoList } from "../sessions/todo-list";
import { VIEW_ICONS } from "./view-icons";
import type { ToolsView } from "./workspace-inspector";

export function WorkspaceOverview({
	tasks,
	items,
	changes,
	pullRequests,
	repository,
	desktop,
	turnRunning = false,
	onOpen,
	onIntent,
}: {
	/** The pointer or focus reached a view's card: it may open next. */
	onIntent?: (view: ToolsView) => void;
	tasks: readonly AgentTask[];
	items: readonly SessionItem[];
	changes: readonly FileChangeEntry[];
	pullRequests: readonly ListedPullRequest[];
	repository?: string;
	desktop: WorkspaceDesktop;
	/** The agent is working in this chat now: only then does an in-progress todo spin. */
	turnRunning?: boolean;
	onOpen: (view: ToolsView) => void;
}) {
	const plan = items.filter((item) => item.kind === "plan").at(-1);
	const todoPlan = items
		.filter((item) => item.kind === "plan" && item.todos !== undefined)
		.at(-1);
	const totals = fileChangeTotals(changes);
	const cards = [
		{
			view: "diff",
			title: "Diffs",
			detail: `${changes.length} ${changes.length === 1 ? "file" : "files"} changed`,
			icon: VIEW_ICONS.diff,
		},
		{
			view: "files",
			title: "Files",
			detail: repository ?? "Workspace files",
			icon: VIEW_ICONS.files,
		},
		{
			view: "desktop",
			title: "Desktop",
			detail:
				desktop.status === "stopped"
					? "Not running"
					: desktop.status === "running"
						? "Running"
						: desktop.status === "starting"
							? "Starting"
							: "Unavailable",
			icon: VIEW_ICONS.desktop,
		},
		{
			view: "terminal",
			title: "Terminal",
			detail: "Workspace shell",
			icon: VIEW_ICONS.terminal,
		},
	] as const;
	return (
		<section className="workspace-overview" aria-label="Overview">
			{/* The pull request first: it stays in view however long the lists get. */}
			{pullRequests.length > 0 ? (
				<section className="overview-section">
					<h2>
						Pull requests <span>{pullRequests.length}</span>
					</h2>
					{pullRequests.map((pr) => (
						<button
							key={pr.number}
							type="button"
							className="overview-pr"
							onPointerEnter={() => onIntent?.("pr")}
							onFocus={() => onIntent?.("pr")}
							onClick={() => onOpen("pr")}
						>
							<GitPullRequest size={16} />
							<span>
								<strong>#{pr.number}</strong> {pr.head}
								<small>
									{sidebarChatPrNeedLabel(sidebarChatPrNeedFromPullRequest(pr))}
								</small>
							</span>
							<ChevronRight size={14} />
						</button>
					))}
				</section>
			) : null}
			{todoPlan?.kind === "plan" && todoPlan.todos?.length ? (
				<TodoList todos={todoPlan.todos} live={turnRunning} />
			) : null}
			{plan?.text && !todoPlan ? (
				<section className="overview-section">
					<h2>Plan</h2>
					<AgentMarkdown text={plan.text} />
				</section>
			) : null}
			{tasks.length ? <TaskPanel tasks={tasks} /> : null}
			<div className="overview-cards">
				{cards.map((card) => (
					<button
						key={card.view}
						className="overview-card"
						type="button"
						onPointerEnter={() => onIntent?.(card.view)}
						onFocus={() => onIntent?.(card.view)}
						onClick={() => onOpen(card.view)}
					>
						<card.icon size={16} />
						<span>
							<strong>{card.title}</strong>
							<small>{card.detail}</small>
						</span>
						{card.view === "diff" &&
						(totals.additions > 0 || totals.deletions > 0) ? (
							<span className="overview-diff-counts">
								<span>+{totals.additions}</span>{" "}
								<span>−{totals.deletions}</span>
							</span>
						) : null}
						<ChevronRight size={14} />
					</button>
				))}
			</div>
		</section>
	);
}
