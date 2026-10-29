import {
	ArrowUp,
	ArrowUpDown,
	BookMarked,
	BookmarkPlus,
	Check,
	ChevronDown,
	ChevronRight,
	GitMerge,
	GitPullRequest,
	ListTodo,
	MessageCircleQuestion,
	PanelLeft,
	Paperclip,
	Plus,
	TriangleAlert,
} from "lucide-react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { HELPER_COLORS, KIND_ICONS } from "#/domain/helper-names";
import { ActivityIcon } from "#/features/sessions/activity-icon";
import { AgentIcon } from "#/features/sessions/agent-icon";
import { FileChangeCounts } from "#/features/sessions/file-change-counts";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { TodoList } from "#/features/sessions/todo-list";

/** The mockup's helpers, as the product names and colours them. */
export const SHOT_HELPERS = [
	{
		name: "build-1",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[2],
		task: "Theme tokens and the toggle",
		done: true,
	},
	{
		name: "build-2",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[0],
		task: "Settings page",
		done: true,
	},
	{
		name: "verify-1",
		icon: KIND_ICONS.checker,
		color: HELPER_COLORS[4],
		task: "Check it in the browser",
		done: false,
	},
] as const;

/**
 * The whole app at work, drawn with the product's own icons and Overview
 * components: the chats by status, a turn with helpers and memory, and the
 * Overview with the todos, helpers and the pull request.
 */
export function AppShot() {
	return (
		<div className="app-shot" aria-hidden="true">
			<Sidebar />
			<Chat />
			<Inspector />
		</div>
	);
}

function Row({
	title,
	dot,
	mark,
	working,
	unread,
	active,
}: {
	title: string;
	dot: string;
	mark: React.ReactNode;
	working?: boolean;
	unread?: boolean;
	active?: boolean;
}) {
	return (
		<div
			className="as-row"
			data-active={active || undefined}
			data-unread={unread || undefined}
		>
			<span className="as-row-dot" style={{ background: dot }} />
			<span className={working ? "as-row-title as-shimmer" : "as-row-title"}>
				{title}
			</span>
			{mark}
		</div>
	);
}

const WEB = "#83C1FF";
const API = "#C9E697";

function Sidebar() {
	return (
		<aside className="as-sidebar">
			<div className="as-brand">
				<span>
					<img src="/brand/mark.svg" width={20} height={20} alt="" />
					ytimesy
				</span>
				<PanelLeft size={16} strokeWidth={1.5} />
			</div>
			<p className="as-nav">
				<Plus size={16} strokeWidth={1.5} />
				New project
			</p>
			<p className="as-nav">
				<BookMarked size={16} strokeWidth={1.5} />
				Memory
			</p>
			<p className="as-list-head">
				Chats
				<ArrowUpDown size={14} strokeWidth={1.5} />
			</p>
			<p className="as-heading">
				Needs you <span>1</span>
			</p>
			<Row
				title="Pick a chart library"
				dot={WEB}
				mark={
					<span className="as-mark as-mark-asking">
						<MessageCircleQuestion size={14} strokeWidth={2} />
					</span>
				}
			/>
			<p className="as-heading">
				Working <span>2</span>
			</p>
			<Row
				title="Add dark mode"
				dot={WEB}
				active
				working
				mark={<span className="as-age">now</span>}
			/>
			<Row
				title="Speed up search"
				dot={API}
				working
				mark={<span className="as-age">2m</span>}
			/>
			<p className="as-heading">
				Done <span>4</span>
			</p>
			<Row
				title="Fix login redirect"
				dot={WEB}
				mark={
					<span className="as-mark as-mark-open">
						<GitPullRequest size={14} strokeWidth={2} />
						127
						<Check size={11} strokeWidth={2.6} />
					</span>
				}
			/>
			<Row
				title="Upgrade the router"
				dot={API}
				mark={
					<span className="as-mark as-mark-merged">
						<GitMerge size={14} strokeWidth={2} />
						124
					</span>
				}
			/>
			<Row
				title="Cache API responses"
				dot={API}
				mark={
					<span className="as-mark as-mark-failed">
						<TriangleAlert size={14} strokeWidth={2} />
					</span>
				}
			/>
			<Row
				title="Write onboarding emails"
				dot={WEB}
				unread
				mark={<span className="as-unread" />}
			/>
			<div className="as-account">
				<span className="as-initials">Y</span>
				<span>
					You
					<small>Settings</small>
				</span>
			</div>
		</aside>
	);
}

function Chat() {
	return (
		<section className="as-chat">
			<div className="as-timeline">
				<p className="as-user">
					Add a dark mode toggle to settings. Keep the brand colors.
				</p>
				<p className="as-text">
					I'll split this: one helper on the theme tokens, one on the settings
					page, then check it end to end.
				</p>
				<p className="as-step">
					<ActivityIcon glyph="read" />
					Explored 9 files
				</p>
				{SHOT_HELPERS.map((helper) => (
					<p key={helper.name} className="helper-line">
						<AgentIcon icon={helper.icon} color={helper.color} size={14} />
						<span className="helper-line-name">{helper.name}</span>
						<span className="helper-line-text">started · {helper.task}</span>
					</p>
				))}
				<p className="as-step">
					<ActivityIcon glyph="edit" />
					Edited 6 files
					<FileChangeCounts additions={184} deletions={37} />
				</p>
				<p className="as-step">
					<ActivityIcon glyph="shell" />
					Ran pnpm test
				</p>
				<div className="memory-marker as-memory" data-kind="save">
					<p className="memory-marker-summary">
						<BookmarkPlus
							className="memory-marker-icon"
							size={14}
							strokeWidth={1.5}
						/>
						<span className="memory-marker-title">Saved 1 memory</span>
						<ChevronRight size={14} className="session-activity-chevron" />
					</p>
				</div>
			</div>
			<div className="as-composer">
				<span className="as-placeholder">Ask for follow-up changes</span>
				<div className="as-composer-bar">
					<Paperclip className="size-4" />
					<span className="as-model">
						<ModelProviderLogo provider="openai" size={14} />
						GPT-6 Astra
						<ChevronDown className="size-3" />
					</span>
					<span className="as-send">
						<ArrowUp className="size-4" />
					</span>
				</div>
			</div>
		</section>
	);
}

function Inspector() {
	return (
		<aside className="as-inspector">
			<div className="as-tabs">
				<span className="as-tab-active">
					<ListTodo size={16} />
					Overview
				</span>
				<Plus size={16} />
			</div>
			<div className="workspace-overview as-overview">
				<TodoList
					todos={[
						{ text: "Theme tokens", status: "completed" },
						{ text: "Settings toggle", status: "completed" },
						{ text: "Check it in the browser", status: "in_progress" },
						{ text: "Open the pull request", status: "pending" },
					]}
				/>
				<section className="task-panel" aria-label="Agents">
					<header className="task-panel-header">
						<h2>
							Agents <span className="task-count">3</span>
						</h2>
						<span className="task-count">2/3 completed</span>
					</header>
					<ol className="task-list">
						{SHOT_HELPERS.map((helper) => (
							<li key={helper.name} className="task-row">
								<span
									className="task-status"
									data-status={helper.done ? "done" : "working"}
								>
									{helper.done ? <Check size={14} /> : <MatrixDotLoader />}
								</span>
								<div className="task-row-copy">
									<div>
										<span className="task-agent">
											<AgentIcon icon={helper.icon} color={helper.color} />
											<strong>{helper.name}</strong>
										</span>
										<span className="task-label">{helper.task}</span>
									</div>
								</div>
							</li>
						))}
					</ol>
				</section>
				<section className="overview-section">
					<h2>
						Pull requests <span>1</span>
					</h2>
					<div className="overview-pr">
						<GitPullRequest size={16} />
						<span>
							<strong>#128</strong> ytimesy/dark-mode
							<small>Ready to merge</small>
						</span>
						<ChevronRight size={14} />
					</div>
				</section>
			</div>
		</aside>
	);
}
