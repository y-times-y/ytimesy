import {
	ArrowUp,
	ArrowUpDown,
	BookMarked,
	BookmarkPlus,
	Check,
	ChevronDown,
	ChevronRight,
	CornerDownRight,
	GitMerge,
	GitPullRequest,
	ListTodo,
	PanelLeft,
	Paperclip,
	Plus,
	TriangleAlert,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { SessionItemId } from "#/domain/ids";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { ActivityIcon } from "#/features/sessions/activity-icon";
import { AgentIcon } from "#/features/sessions/agent-icon";
import { FileChangeCounts } from "#/features/sessions/file-change-counts";
import { FileTypeIcon } from "#/features/sessions/file-type-icon";
import { primeHighlightedLines } from "#/features/sessions/highlighted-code";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { TodoList } from "#/features/sessions/todo-list";
import { ToolDetailBody } from "#/features/sessions/tool-detail-body";
import {
	DEMO_AGENTS,
	DEMO_CHATS,
	DEMO_EDIT,
	type DemoAgent,
	type DemoChat,
	type DemoItem,
} from "./landing-demo";
import { demoEditLanguage, demoEditSource } from "./landing-diff-tokens";
import { demoEditTokens } from "./landing-diff-tokens.gen";

/** The preview's agents, for the front page's fleet tile. */
export const SHOT_HELPERS = DEMO_AGENTS;

// The open edit paints coloured on the server render and the first paint.
primeHighlightedLines(demoEditSource, demoEditLanguage, demoEditTokens);

const WEB = "#83C1FF";
const API = "#C9E697";

const toolItem = (
	id: string,
	tool: string,
	input: object,
	output: string,
	failed = false,
): DynamicToolCallItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool,
	input: JSON.stringify(input),
	output,
	status: failed ? "failed" : "completed",
});

const EDIT_ITEM = toolItem(
	"demo-edit",
	"edit",
	{
		path: DEMO_EDIT.path,
		edits: DEMO_EDIT.hunks.map((hunk) => ({
			old_string: hunk.removed,
			new_string: hunk.added,
		})),
	},
	"Updated appearance.tsx: 2 edits applied.",
);

/**
 * The whole app at work, drawn with the product's own icons, activity rows,
 * tool views and Overview components. Chats open (the others show their
 * opening message), the dark mode chat's steps expand, and sending from the
 * composer goes to sign-up.
 */
export function AppShot() {
	const [activeId, setActiveId] = useState("dark");
	const active =
		DEMO_CHATS.find((chat) => chat.id === activeId) ?? DEMO_CHATS[0];
	if (!active) return null;
	return (
		<section className="app-shot" aria-label="Product preview">
			<Sidebar chats={DEMO_CHATS} activeId={active.id} onOpen={setActiveId} />
			<Chat key={active.id} chat={active} />
			<Inspector chat={active} />
		</section>
	);
}

function Sidebar({
	chats,
	activeId,
	onOpen,
}: {
	chats: readonly DemoChat[];
	activeId: string;
	onOpen: (id: string) => void;
}) {
	const groups = [
		["Working", chats.filter((chat) => chat.status === "working")],
		["Done", chats.filter((chat) => chat.status !== "working")],
	] as const;
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
			{groups.map(([heading, rows]) =>
				rows.length ? (
					<div key={heading}>
						<p className="as-heading">
							{heading} <span>{rows.length}</span>
						</p>
						{rows.map((chat) => (
							<button
								key={chat.id}
								type="button"
								className="as-row"
								data-active={chat.id === activeId || undefined}
								data-unread={
									(chat.status === "unread" && chat.id !== activeId) ||
									undefined
								}
								aria-current={chat.id === activeId || undefined}
								onClick={() => onOpen(chat.id)}
							>
								<span
									className="as-row-dot"
									style={{ background: chat.project === "web" ? WEB : API }}
								/>
								<span
									className={
										chat.status === "working"
											? "as-row-title as-shimmer"
											: "as-row-title"
									}
								>
									{chat.title}
								</span>
								<RowMark chat={chat} active={chat.id === activeId} />
							</button>
						))}
					</div>
				) : null,
			)}
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

function RowMark({ chat, active }: { chat: DemoChat; active: boolean }) {
	switch (chat.status) {
		case "working":
			return <span className="as-age">{chat.age}</span>;
		case "open":
			return (
				<span className="as-mark as-mark-open">
					<GitPullRequest size={14} strokeWidth={2} />
					{chat.pr?.number}
					<Check size={11} strokeWidth={2.6} />
				</span>
			);
		case "merged":
			return (
				<span className="as-mark as-mark-merged">
					<GitMerge size={14} strokeWidth={2} />
					{chat.pr?.number}
				</span>
			);
		case "failed":
			return (
				<span className="as-mark as-mark-failed">
					<TriangleAlert size={14} strokeWidth={2} />
				</span>
			);
		case "unread":
			return active ? null : <span className="as-unread" />;
	}
}

function Chat({ chat }: { chat: DemoChat }) {
	const [draft, setDraft] = useState("");
	const [sent, setSent] = useState<string[]>([]);
	const timeline = useRef<HTMLDivElement>(null);
	// The edit is the one step the preview opens by default.
	const [open, setOpen] = useState<Record<number, boolean>>(() =>
		Object.fromEntries(
			chat.turn.map((item, index) => [index, item.kind === "edit"]),
		),
	);
	const toggle = (index: number) =>
		setOpen((current) => ({ ...current, [index]: !current[index] }));
	// A sent message and its reply come into view.
	useEffect(() => {
		if (!sent.length) return;
		const element = timeline.current;
		element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [sent]);
	return (
		<section className="as-chat">
			<div className="as-timeline" ref={timeline}>
				{chat.turn.map((item, index) => (
					<TurnItem
						// biome-ignore lint/suspicious/noArrayIndexKey: a turn's items keep their order
						key={index}
						item={item}
						open={Boolean(open[index])}
						onToggle={() => toggle(index)}
					/>
				))}
				{sent.map((text, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: sent messages keep their order
					<SentMessage key={index} text={text} />
				))}
			</div>
			{/* Without scripts the form still works: sending opens sign-up. The
			    input has no name, so the message is not put in the address. */}
			<form
				className="as-composer"
				method="get"
				action="/auth/sign-up"
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					const text = draft.trim();
					if (!text) return;
					setSent((current) => [...current, text]);
					setDraft("");
				}}
			>
				<input
					className="as-input"
					value={draft}
					placeholder="Ask for follow-up changes"
					aria-label="Message"
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="as-composer-bar">
					<Paperclip className="size-4" />
					<span className="as-model">
						<ModelProviderLogo provider="openai" size={14} />
						GPT-6 Astra
						<ChevronDown className="size-3" />
					</span>
					<button
						type="submit"
						className="as-send"
						aria-label="Send"
						disabled={!draft.trim()}
					>
						<ArrowUp className="size-4" />
					</button>
				</div>
			</form>
		</section>
	);
}

/** A message sent from the preview and the reply: sign in to run it. */
function SentMessage({ text }: { text: string }) {
	return (
		<>
			<p className="as-user">{text}</p>
			<div className="as-signin">
				<p className="as-text">Sign in and I'll run this on your repo.</p>
				<div className="as-signin-actions">
					<a className="landing-button" href="/auth/sign-up">
						Get started
					</a>
					<a className="as-signin-secondary" href="/auth/sign-in">
						Sign in
					</a>
				</div>
			</div>
		</>
	);
}

function Step({
	open,
	onToggle,
	children,
}: {
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="as-step"
			aria-expanded={open}
			onClick={onToggle}
		>
			{children}
			<ChevronRight
				size={14}
				className="as-step-chevron"
				data-open={open || undefined}
			/>
		</button>
	);
}

function TurnItem({
	item,
	open,
	onToggle,
}: {
	item: DemoItem;
	open: boolean;
	onToggle: () => void;
}) {
	switch (item.kind) {
		case "user":
			return <p className="as-user">{item.text}</p>;
		case "step":
			return (
				<p className="as-step">
					<ActivityIcon glyph={item.glyph} />
					{item.label}
					{item.additions || item.deletions ? (
						<FileChangeCounts
							additions={item.additions ?? 0}
							deletions={item.deletions ?? 0}
						/>
					) : null}
				</p>
			);
		case "wake":
			return (
				<p className="as-step as-wake">
					<CornerDownRight size={14} />
					{item.text}
				</p>
			);
		case "text":
			return <p className="as-text">{item.text}</p>;
		case "explored":
			return (
				<div>
					<Step open={open} onToggle={onToggle}>
						<ActivityIcon glyph="read" />
						Explored {item.files.length}{" "}
						{item.files.length === 1 ? "file" : "files"}
					</Step>
					{open ? (
						<ul className="as-files">
							{item.files.map((path) => (
								<li key={path} className="as-file">
									<FileTypeIcon path={path} size={14} />
									{path}
								</li>
							))}
						</ul>
					) : null}
				</div>
			);
		case "agent":
			return <AgentLine agent={item.agent} />;
		case "edit":
			return (
				<div>
					<Step open={open} onToggle={onToggle}>
						<ActivityIcon glyph="edit" />
						Edited appearance.tsx
						<FileChangeCounts additions={7} deletions={2} />
					</Step>
					{open ? (
						<div className="as-detail">
							<ToolDetailBody item={EDIT_ITEM} />
						</div>
					) : null}
				</div>
			);
		case "ran":
			return (
				<div>
					<Step open={open} onToggle={onToggle}>
						<ActivityIcon glyph="shell" />
						{item.failed ? "Failed" : "Ran"} {item.command}
					</Step>
					{open ? (
						<div className="as-detail">
							<ToolDetailBody
								item={toolItem(
									item.command,
									"bash",
									{ command: item.command },
									`${item.output}\nexit ${item.failed ? 1 : 0}`,
								)}
							/>
						</div>
					) : null}
				</div>
			);
		case "memory":
			return (
				<div className="memory-marker as-memory" data-kind="save">
					<button
						type="button"
						className="memory-marker-summary"
						aria-expanded={open}
						onClick={onToggle}
					>
						<BookmarkPlus
							className="memory-marker-icon"
							size={14}
							strokeWidth={1.5}
						/>
						<span className="memory-marker-title">Saved 1 memory</span>
						<ChevronRight
							size={14}
							className="as-step-chevron"
							data-open={open || undefined}
						/>
					</button>
					{open ? (
						<p className="as-memory-line">
							{item.text}
							<span>MEMORY.md</span>
						</p>
					) : null}
				</div>
			);
	}
}

function AgentLine({ agent }: { agent: DemoAgent }) {
	return (
		<p className="helper-line">
			<AgentIcon icon={agent.icon} color={agent.color} size={14} />
			<span className="helper-line-name">{agent.name}</span>
			<span className="helper-line-text">started · {agent.task}</span>
		</p>
	);
}

function Inspector({ chat }: { chat: DemoChat }) {
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
				{chat.todos ? <TodoList todos={[...chat.todos]} /> : null}
				{chat.agents ? (
					<section className="task-panel" aria-label="Agents">
						<header className="task-panel-header">
							<h2>
								Agents <span className="task-count">{DEMO_AGENTS.length}</span>
							</h2>
							<span className="task-count">
								{DEMO_AGENTS.filter((agent) => agent.done).length}/
								{DEMO_AGENTS.length} completed
							</span>
						</header>
						<ol className="task-list">
							{DEMO_AGENTS.map((agent) => (
								<li key={agent.name} className="task-row">
									<span
										className="task-status"
										data-status={agent.done ? "done" : "working"}
									>
										{agent.done ? <Check size={14} /> : <MatrixDotLoader />}
									</span>
									<div className="task-row-copy">
										<div>
											<span className="task-agent">
												<AgentIcon icon={agent.icon} color={agent.color} />
												<strong>{agent.name}</strong>
											</span>
											<span className="task-label">{agent.task}</span>
										</div>
									</div>
								</li>
							))}
						</ol>
					</section>
				) : null}
				{chat.pr ? (
					<section className="overview-section">
						<h2>
							Pull requests <span>1</span>
						</h2>
						<div className="overview-pr">
							{chat.status === "merged" ? (
								<GitMerge size={16} />
							) : (
								<GitPullRequest size={16} />
							)}
							<span>
								<strong>#{chat.pr.number}</strong> {chat.pr.branch}
								<small data-tone={chat.status === "failed" ? "bad" : undefined}>
									{chat.pr.state}
								</small>
							</span>
							<ChevronRight size={14} />
						</div>
					</section>
				) : null}
				{!chat.todos && !chat.agents && !chat.pr ? (
					<p className="as-empty">Nothing to track in this chat.</p>
				) : null}
			</div>
		</aside>
	);
}
