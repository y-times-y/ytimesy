import { Link } from "@tanstack/react-router";
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
	MessageCircleQuestion,
	PanelLeft,
	Paperclip,
	Plus,
	TriangleAlert,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
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

type Extra =
	| { kind: "user"; text: string }
	| { kind: "preview" }
	| { kind: "answered"; option: string };

/**
 * The whole app at work, drawn with the product's own icons, activity rows,
 * tool views and Overview components. Clicks work: chats open, steps
 * expand, the question can be answered and the composer sends. Nothing
 * runs; a sent message says so and links to sign-up.
 */
export function AppShot() {
	const [activeId, setActiveId] = useState("dark");
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [extras, setExtras] = useState<Record<string, Extra[]>>({});
	const chats = DEMO_CHATS.map((chat) =>
		answers[chat.id]
			? { ...chat, status: "working" as const, age: "now" }
			: chat,
	);
	const active = chats.find((chat) => chat.id === activeId) ?? chats[0];
	const add = (chatId: string, ...items: Extra[]) =>
		setExtras((current) => ({
			...current,
			[chatId]: [...(current[chatId] ?? []), ...items],
		}));
	if (!active) return null;
	return (
		<section className="app-shot" aria-label="Product preview">
			<Sidebar chats={chats} activeId={active.id} onOpen={setActiveId} />
			<Chat
				key={active.id}
				chat={active}
				answer={answers[active.id]}
				extras={extras[active.id] ?? []}
				onAnswer={(option) => {
					setAnswers((current) => ({ ...current, [active.id]: option }));
					add(active.id, { kind: "answered", option });
				}}
				onSend={(text) =>
					add(active.id, { kind: "user", text }, { kind: "preview" })
				}
			/>
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
		["Needs you", chats.filter((chat) => chat.status === "asking")],
		["Working", chats.filter((chat) => chat.status === "working")],
		[
			"Done",
			chats.filter(
				(chat) => chat.status !== "asking" && chat.status !== "working",
			),
		],
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
		case "asking":
			return (
				<span className="as-mark as-mark-asking">
					<MessageCircleQuestion size={14} strokeWidth={2} />
				</span>
			);
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

function Chat({
	chat,
	answer,
	extras,
	onAnswer,
	onSend,
}: {
	chat: DemoChat;
	answer: string | undefined;
	extras: readonly Extra[];
	onAnswer: (option: string) => void;
	onSend: (text: string) => void;
}) {
	const [draft, setDraft] = useState("");
	// The edit is the one step the preview opens by default.
	const [open, setOpen] = useState<Record<number, boolean>>(() =>
		Object.fromEntries(
			chat.turn.map((item, index) => [index, item.kind === "edit"]),
		),
	);
	const toggle = (index: number) =>
		setOpen((current) => ({ ...current, [index]: !current[index] }));
	const send = (event: FormEvent) => {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		onSend(text);
		setDraft("");
	};
	return (
		<section className="as-chat">
			<div className="as-timeline">
				{chat.turn.map((item, index) => (
					<TurnItem
						// biome-ignore lint/suspicious/noArrayIndexKey: a turn's items keep their order
						key={index}
						item={item}
						open={Boolean(open[index])}
						onToggle={() => toggle(index)}
						answer={answer}
						onAnswer={onAnswer}
					/>
				))}
				{extras.map((extra, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: added messages keep their order
					<ExtraItem key={index} extra={extra} />
				))}
			</div>
			<form className="as-composer" onSubmit={send}>
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

function ExtraItem({ extra }: { extra: Extra }) {
	if (extra.kind === "user") return <p className="as-user">{extra.text}</p>;
	if (extra.kind === "answered")
		return (
			<>
				<p className="as-user">{extra.option}</p>
				<p className="as-text">
					Going with {extra.option}. Adding it to the dashboard now.
				</p>
			</>
		);
	return (
		<p className="as-text as-preview-note">
			This is a preview, so nothing runs here.{" "}
			<Link
				to="/auth/$path"
				params={{ path: "sign-up" }}
				search={{ error: undefined, redirectTo: undefined }}
			>
				Run it on your repo
			</Link>
		</p>
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
	answer,
	onAnswer,
}: {
	item: DemoItem;
	open: boolean;
	onToggle: () => void;
	answer: string | undefined;
	onAnswer: (option: string) => void;
}) {
	switch (item.kind) {
		case "user":
			return <p className="as-user">{item.text}</p>;
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
		case "question":
			return (
				<div className="as-question">
					<p className="as-text">{item.text}</p>
					<div className="as-options">
						{item.options.map((option) => (
							<button
								key={option}
								type="button"
								className="as-option"
								aria-pressed={answer === option}
								disabled={Boolean(answer)}
								onClick={() => onAnswer(option)}
							>
								{option}
							</button>
						))}
					</div>
				</div>
			);
		case "wake":
			return (
				<p className="as-step as-wake">
					<CornerDownRight size={14} />
					{item.text}
				</p>
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
