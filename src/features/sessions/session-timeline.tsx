import {
	Activity,
	Check,
	ChevronRight,
	CircleAlert,
	Clock3,
	ImageIcon,
	Paperclip,
	SquareTerminal,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, type UIEvent, useEffect, useRef } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { agentCall } from "#/domain/agent-call";
import {
	BACKGROUND_COMMAND_KIND_TAG,
	type BackgroundCommandRecord,
	backgroundCommandStateText,
	backgroundCommandStatus,
} from "#/domain/background-command";
import { checkSummary } from "#/domain/check-summary";
import {
	type AgentTaskActivity,
	childTaskAnchorId,
	childTaskPublicItems,
} from "#/domain/child-task-activity";
import {
	codeModeCallItems,
	codeModeProgram,
	codeModeResult,
} from "#/domain/code-mode";
import { commandActivityTitle } from "#/domain/command-activity-title";
import { fileChangeTotals } from "#/domain/diff-preview";
import {
	fileChangeActivity,
	fileChangeActivityTitle,
} from "#/domain/file-change-copy";
import { fileBasename } from "#/domain/file-kind";
import { listedModelDisplayName } from "#/domain/listed-model";
import { parseModelRouteId } from "#/domain/model-connection";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import { requirementsSegments } from "#/domain/rigor";
import { secretRequestOutcome } from "#/domain/secret-request";
import { activityGlyphForToolName } from "#/domain/session-activity";
import {
	compactTimelineItems,
	type FileChangeEntry,
	fileChangesFromSessionItems,
	isQueuedUserMessage,
	liveActivityStatus,
	type SessionItem,
	type SessionTurnStatus,
	showTurnWorking,
	type UserMessageItem,
} from "#/domain/session-item";
import { subagentLabelFromTaskLabel } from "#/domain/subagent";
import { thoughtLabel } from "#/domain/thought-label";
import {
	explorationGroupIsLive,
	explorationLabel,
	groupExplorationRows,
	groupTimelineRows,
	type TimelineRow,
} from "#/domain/timeline-activity";
import {
	toolActivity,
	toolCommand,
	toolDetailTitle,
	toolOutputText,
} from "#/domain/tool-detail";
import { userQuestionReply } from "#/domain/user-question";
import { evidenceAnchors } from "../evidence/evidence-anchors";
import { EvidenceCard } from "../evidence/evidence-view";
import { ActivityIcon } from "./activity-icon";
import { AgentMarkdown } from "./agent-markdown";
import { FileChangeCounts } from "./file-change-counts";
import { FileMentionButton } from "./file-mention";
import { LiveCollapsible } from "./live-collapsible";
import {
	type MemoryMarkerActions,
	MemoryMarkerProvider,
	MemoryRecallNote,
	MemorySaveNote,
} from "./memory-markers";
import {
	answeredAfter,
	type FailoverActions,
	ModelSwitchCard,
} from "./model-switch-card";
import {
	type SecretRequestActions,
	SecretRequestCard,
} from "./secret-request-card";
import { ShellCommandCode } from "./shell-command-code";
import { TodoList } from "./todo-list";
import {
	AgentCallView,
	CheckVerdictCard,
	RequirementsList,
	ToolInputFields,
} from "./tool-cards";
import {
	type UserQuestionActions,
	UserQuestionCard,
} from "./user-question-card";

export function SessionTimeline({
	items: allItems,
	turnStatus,
	fill = false,
	onOpenFile,
	tasks = [],
	taskParentId,
	autoScroll = true,
	collapseInstructions = false,
	recoveryControls,
	secretActions,
	questionActions,
	failoverActions,
	memoryActions,
	onRemoveQueued,
	evidence = [],
}: {
	/** Pull request evidence captured for this chat's turns (prEvidence). */
	evidence?: readonly EvidenceRecord[];
	/** Takes back a message still waiting behind the running turn. */
	onRemoveQueued?: (messageId: string) => void;
	/** Opens, undoes and checks the memory lines a turn recalled or saved. */
	memoryActions?: MemoryMarkerActions;
	/** Save or skip a secret the agent asked for; omitted where nobody can answer. */
	secretActions?: SecretRequestActions;
	/** Answer the agent's question card; omitted where nobody can answer. */
	questionActions?: UserQuestionActions;
	/** Continue on the fallback a paused turn offers; omitted where nobody can answer. */
	failoverActions?: FailoverActions;
	recoveryControls?: (messageId: string) => ReactNode;
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	fill?: boolean;
	onOpenFile?: (path: string) => void;
	tasks?: readonly AgentTaskActivity[];
	taskParentId?: string;
	autoScroll?: boolean;
	collapseInstructions?: boolean;
}) {
	const listRef = useRef<HTMLOListElement>(null);
	const stickToEnd = useRef(true);
	// Waiting messages are not part of the turn yet; they sit below its activity.
	const queued = allItems.filter(isQueuedUserMessage);
	const items = queued.length
		? allItems.filter((item) => !isQueuedUserMessage(item))
		: allItems;
	const visible = compactTimelineItems(childTaskPublicItems(items));
	const childTasks = tasks.filter((task) =>
		taskParentId ? task.parentSessionId === taskParentId : task.depth === 1,
	);
	const rows = groupTimelineRows(visible, turnStatus);
	const evidenceAt = evidenceAnchors(visible, evidence);
	const fileChanges = fileChangesFromSessionItems(items);
	const currentTurnIds = new Set<SessionItem["id"]>();
	for (const item of visible) {
		if (item.kind === "userMessage") currentTurnIds.clear();
		else currentTurnIds.add(item.id);
	}

	useEffect(() => {
		if (!autoScroll || !stickToEnd.current) return;
		if (allItems.length === 0 && turnStatus !== "running") return;
		listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
	}, [autoScroll, allItems, turnStatus]);

	function rememberScrollPin(event: UIEvent<HTMLOListElement>) {
		const list = event.currentTarget;
		stickToEnd.current =
			list.scrollHeight - list.scrollTop - list.clientHeight < 64;
	}

	if (
		visible.length === 0 &&
		queued.length === 0 &&
		childTasks.length === 0 &&
		evidence.length === 0 &&
		turnStatus !== "running" &&
		!fill
	)
		return null;

	return (
		<MemoryMarkerProvider actions={memoryActions}>
			<ol
				ref={listRef}
				className="session-timeline"
				aria-label="Session"
				onScroll={rememberScrollPin}
			>
				{rows.map((row) => {
					const rowId = row.kind === "item" ? row.item.id : row.id;
					return (
						<Fragment
							key={row.kind === "item" ? row.item.id : `${row.kind}:${row.id}`}
						>
							<li data-kind={row.kind === "item" ? row.item.kind : row.kind}>
								{row.kind === "item" && row.item.kind === "planProposal" ? (
									<PlanMessage text={row.item.text} onOpenFile={onOpenFile} />
								) : row.kind === "item" && row.item.kind === "userQuestion" ? (
									<UserQuestionCard
										item={row.item}
										reply={userQuestionReply(items, row.item.id)}
										actions={questionActions}
									/>
								) : row.kind === "item" && row.item.kind === "secretRequest" ? (
									<SecretRequestCard
										item={row.item}
										outcome={secretRequestOutcome(items, row.item.id)}
										actions={secretActions}
									/>
								) : row.kind === "item" &&
									row.item.kind === "modelSwitch" &&
									row.item.state === "awaitingApproval" ? (
									<ModelSwitchCard
										item={row.item}
										answered={answeredAfter(items, row.item.id)}
										actions={failoverActions}
									/>
								) : (
									<TimelineRowView
										row={row}
										collapseInstructions={collapseInstructions}
										turnRunning={
											turnStatus === "running" && currentTurnIds.has(rowId)
										}
										isLastItem={
											(row.kind === "item"
												? row.item.id
												: row.items.at(-1)?.id) === visible.at(-1)?.id
										}
										fileChanges={fileChanges}
										onOpenFile={onOpenFile}
									/>
								)}
								{row.kind === "item" && row.item.kind === "userMessage"
									? recoveryControls?.(row.item.id)
									: null}
							</li>
							{childTasks
								.filter((task) => {
									const anchor = childTaskAnchorId(task, visible);
									return row.kind === "item"
										? anchor === row.item.id
										: row.items.some((item) => item.id === anchor);
								})
								.map((task) => (
									<li key={`child:${task.id}`} data-kind="child-task">
										<ChildTaskCard
											task={task}
											tasks={tasks}
											onOpenFile={onOpenFile}
										/>
									</li>
								))}
							{(row.kind === "item"
								? (evidenceAt.anchored.get(row.item.id) ?? [])
								: row.items.flatMap(
										(item) => evidenceAt.anchored.get(item.id) ?? [],
									)
							).map((record) => (
								<li key={`evidence:${record.id}`} data-kind="evidence">
									<EvidenceCard evidence={record} />
								</li>
							))}
						</Fragment>
					);
				})}
				{childTasks
					.filter((task) => !childTaskAnchorId(task, visible))
					.map((task) => (
						<li key={`child:${task.id}`} data-kind="child-task">
							<ChildTaskCard
								task={task}
								tasks={tasks}
								onOpenFile={onOpenFile}
							/>
						</li>
					))}
				{evidenceAt.trailing.map((record) => (
					<li key={`evidence:${record.id}`} data-kind="evidence">
						<EvidenceCard evidence={record} />
					</li>
				))}
				{showTurnWorking(items, turnStatus) ? (
					<li data-kind="working">
						<p className="session-working session-shimmer">
							{compactingContext(items) ? "Compacting context" : "Thinking"}
						</p>
					</li>
				) : null}
				{queued.map((item) => (
					<li key={item.id} data-kind="userMessage" data-queued="true">
						<QueuedMessage item={item} onRemove={onRemoveQueued} />
					</li>
				))}
				{turnStatus !== "running" &&
				childTasks.some((task) => task.turnStatus === "running") ? (
					<li data-kind="waiting-for-children">
						<p className="session-working" role="status">
							Waiting for subagents
						</p>
					</li>
				) : null}
			</ol>
		</MemoryMarkerProvider>
	);
}

function QueuedMessage({
	item,
	onRemove,
}: {
	item: UserMessageItem;
	onRemove?: (messageId: string) => void;
}) {
	return (
		<div className="session-message" data-role="user" data-queued="true">
			<p>{item.text}</p>
			{item.attachments?.length ? (
				<ul className="session-message-attachments" aria-label="Attached files">
					{item.attachments.map((attachment) => (
						<li key={attachment.id} title={attachment.name}>
							{attachment.mediaType.startsWith("image/") ? (
								<ImageIcon size={13} aria-hidden="true" />
							) : (
								<Paperclip size={13} aria-hidden="true" />
							)}
							<span>{attachment.name}</span>
						</li>
					))}
				</ul>
			) : null}
			<p className="session-queued-note" role="status">
				<Clock3 size={12} aria-hidden="true" />
				<span>Queued for the agent's next step</span>
				{onRemove ? (
					<button
						type="button"
						aria-label="Remove queued message"
						title="Remove this message before it is delivered"
						onClick={() => onRemove(item.id)}
					>
						<X size={12} aria-hidden="true" />
					</button>
				) : null}
			</p>
		</div>
	);
}

function ChildTaskCard({
	task,
	tasks,
	onOpenFile,
}: {
	task: AgentTaskActivity;
	tasks: readonly AgentTaskActivity[];
	onOpenFile?: (path: string) => void;
}) {
	const children = tasks.filter((child) => child.parentSessionId === task.id);
	const busy = task.status === "working" || task.status === "waiting";
	const status =
		task.status === "done"
			? "Completed"
			: task.status === "failed"
				? "Failed"
				: task.status === "draft"
					? "Starting"
					: busy
						? "Working"
						: "Idle";
	const activity = childTaskPublicItems(task.items);
	const role = task.subagent?.role;
	const who = `${role ? role.charAt(0).toUpperCase() + role.slice(1) : "Agent"} ${subagentLabelFromTaskLabel(task.label)}`;
	return (
		<details className="child-task-card" data-status={task.status}>
			<summary>
				{busy ? (
					<MatrixDotLoader />
				) : (
					<span className="child-task-card-icon" aria-hidden="true">
						{task.status === "done" ? (
							<Check size={14} />
						) : task.status === "failed" ? (
							<CircleAlert size={14} />
						) : (
							<Clock3 size={14} />
						)}
					</span>
				)}
				<span className="child-task-card-copy">
					<strong>{task.title}</strong>
					<small>
						{who}
						{task.listedModelId
							? ` · ${listedModelDisplayName(parseModelRouteId(task.listedModelId)?.modelId ?? task.listedModelId)}`
							: ""}
					</small>
				</span>
				<span className="child-task-card-status">{status}</span>
				<ChevronRight
					className="child-task-card-chevron"
					size={14}
					aria-hidden="true"
				/>
			</summary>
			<div className="child-task-card-content">
				{activity.length ? (
					<SessionTimeline
						items={activity}
						turnStatus={task.turnStatus}
						onOpenFile={onOpenFile}
						autoScroll={false}
						collapseInstructions
					/>
				) : task.summary ? (
					<AgentMarkdown text={task.summary} onOpenFile={onOpenFile} />
				) : (
					<p className="child-task-card-empty">
						{busy ? "Waiting for the first activity…" : "No activity yet."}
					</p>
				)}
				{children.map((child) => (
					<ChildTaskCard
						key={child.id}
						task={child}
						tasks={tasks}
						onOpenFile={onOpenFile}
					/>
				))}
			</div>
		</details>
	);
}

function TimelineRowView({
	row,
	collapseInstructions = false,
	turnRunning,
	isLastItem,
	fileChanges,
	onOpenFile,
}: {
	row: TimelineRow;
	collapseInstructions?: boolean;
	turnRunning: boolean;
	isLastItem: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	if (row.kind === "work") {
		return (
			<details className="session-work">
				<summary>
					<span title="Elapsed time from dispatch to observed completion">
						{row.label}
					</span>
					<ChevronRight size={12} className="session-activity-chevron" />
				</summary>
				<div className="session-work-items">
					{groupExplorationRows(row.items).map((child) => (
						<TimelineRowView
							key={child.kind === "item" ? child.item.id : child.id}
							row={child}
							turnRunning={false}
							isLastItem={false}
							fileChanges={fileChanges}
							onOpenFile={onOpenFile}
						/>
					))}
				</div>
			</details>
		);
	}
	if (row.kind === "exploration") {
		const live = turnRunning && explorationGroupIsLive(row.items);
		return (
			<LiveCollapsible
				className="session-exploration"
				data-live={live ? "true" : undefined}
				live={live}
			>
				<summary>
					<span
						className={
							live
								? "session-activity-title session-shimmer"
								: "session-activity-title"
						}
					>
						{explorationLabel(row.counts)}
					</span>
					<ChevronRight size={12} className="session-activity-chevron" />
				</summary>
				{row.items.map((item) => (
					<SessionItemView
						key={item.id}
						item={item}
						nested
						turnRunning={turnRunning}
						fileChanges={fileChanges}
						onOpenFile={onOpenFile}
					/>
				))}
			</LiveCollapsible>
		);
	}
	return (
		<SessionItemView
			item={row.item}
			collapseInstructions={collapseInstructions}
			thoughtInProgress={turnRunning && isLastItem}
			turnRunning={turnRunning}
			fileChanges={fileChanges}
			onOpenFile={onOpenFile}
		/>
	);
}

function SessionItemView({
	item,
	collapseInstructions = false,
	nested = false,
	thoughtInProgress = false,
	turnRunning = false,
	fileChanges,
	onOpenFile,
}: {
	item: SessionItem;
	collapseInstructions?: boolean;
	nested?: boolean;
	thoughtInProgress?: boolean;
	turnRunning?: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	const live = activityTitleIsLive(item, turnRunning, thoughtInProgress);
	const titleClass = live
		? "session-activity-title session-shimmer"
		: "session-activity-title";
	switch (item.kind) {
		case "userMessage":
			if (collapseInstructions) {
				return (
					<details className="session-work child-task-instructions">
						<summary>
							<span>Brief</span>
							<ChevronRight size={12} className="session-activity-chevron" />
						</summary>
						<div className="session-work-items">
							<AgentMarkdown text={item.text} onOpenFile={onOpenFile} />
						</div>
					</details>
				);
			}
			return (
				<div className="session-message" data-role="user">
					<p>{item.text}</p>
					{item.attachments?.length ? (
						<ul
							className="session-message-attachments"
							aria-label="Attached files"
						>
							{item.attachments.map((attachment) => (
								<li key={attachment.id} title={attachment.name}>
									{attachment.mediaType.startsWith("image/") ? (
										<ImageIcon size={13} aria-hidden="true" />
									) : (
										<Paperclip size={13} aria-hidden="true" />
									)}
									<span>{attachment.name}</span>
								</li>
							))}
						</ul>
					) : null}
					{item.memory ? <MemoryRecallNote recall={item.memory} /> : null}
				</div>
			);
		case "memorySave":
			return <MemorySaveNote item={item} />;
		case "agentMessage":
			return (
				<div
					className="session-message"
					data-role="assistant"
					data-streaming={turnRunning && item.streaming ? "true" : undefined}
				>
					{requirementsSegments(item.text).map((segment, index) =>
						segment.kind === "requirements" ? (
							<RequirementsList
								// biome-ignore lint/suspicious/noArrayIndexKey: a message's segments keep their order
								key={index}
								items={segment.items}
							/>
						) : (
							<AgentMarkdown
								// biome-ignore lint/suspicious/noArrayIndexKey: a message's segments keep their order
								key={index}
								text={segment.text}
								streaming={Boolean(turnRunning && item.streaming)}
								fileChanges={fileChanges}
								onOpenFile={onOpenFile}
							/>
						),
					)}
				</div>
			);
		case "reasoning": {
			const summaries = item.summaries.filter((summary) => summary.trim());
			const title = thoughtLabel({
				durationSeconds: item.durationSeconds,
				inProgress: live,
			});
			if (summaries.length === 0) {
				if (!live) return null;
				return (
					<div
						className="session-activity"
						data-kind="reasoning"
						data-live={live ? "true" : undefined}
					>
						<p>
							<span className={titleClass}>{title}</span>
						</p>
					</div>
				);
			}
			return (
				<LiveCollapsible
					className="session-activity"
					data-kind="reasoning"
					data-live={live ? "true" : undefined}
					live={live}
				>
					<summary>
						<span className={titleClass}>
							{summaries[0]?.split("\n")[0].replace(/^#+\s*|\*\*/g, "") ||
								title}
						</span>
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					{summaries.map((summary) => (
						<p key={`${item.id}:${summary}`}>{summary}</p>
					))}
				</LiveCollapsible>
			);
		}
		case "plan":
			if (item.todos) return <TodoList todos={item.todos} />;
			return (
				<details className="session-activity" data-kind="plan">
					<summary>
						<ActivityIcon glyph="plan" />
						<span className="session-activity-title">Plan</span>
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					<p>{item.text || "Planning…"}</p>
				</details>
			);
		case "userQuestion":
			return <UserQuestionCard item={item} reply={null} />;
		case "secretRequest":
			return <SecretRequestCard item={item} outcome="answered" />;
		case "planProposal":
			return <PlanMessage text={item.text} onOpenFile={onOpenFile} />;
		case "commandExecution": {
			const status = activityStatusLabel(item.status);
			return (
				<details
					className="session-activity"
					data-kind="commandExecution"
					data-status={item.status}
					data-live={live ? "true" : undefined}
				>
					<summary>
						<span className={titleClass}>
							{commandActivityTitle(item.command)}
						</span>
						{status ? (
							<span className="session-activity-status">{status}</span>
						) : null}
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					<div className="session-command-detail">
						<ShellCommandCode command={item.command} />
						{item.output ? (
							<pre className="session-output">{item.output}</pre>
						) : null}
						{item.exitCode !== null ? (
							<p className="session-activity-meta">exit {item.exitCode}</p>
						) : null}
					</div>
				</details>
			);
		}
		case "fileChange": {
			const totals = fileChangeTotals(item.changes);
			const title = fileChangeActivityTitle(item.changes);
			const status = activityStatusLabel(item.status);
			const counts = (
				<FileChangeCounts
					additions={totals.additions}
					deletions={totals.deletions}
				/>
			);
			const progress = status ? (
				<span className="session-activity-status">{status}</span>
			) : null;
			if (item.changes.length === 0) return null;
			if (item.changes.length === 1) {
				const activity = fileChangeActivity(item.changes);
				const change = item.changes[0];
				return (
					<div
						className="session-activity"
						data-kind="fileChange"
						data-status={item.status}
						data-live={live ? "true" : undefined}
						data-nested={nested ? "true" : undefined}
					>
						<p>
							<ActivityIcon glyph="edit" />
							<span className={titleClass}>
								{activity.verb}{" "}
								{change && activity.name ? (
									<FileMentionButton
										path={change.path}
										name={activity.name}
										change={change.change}
										onOpenFile={onOpenFile}
									/>
								) : (
									"1 file"
								)}
							</span>
							{counts}
							{progress}
						</p>
					</div>
				);
			}
			return (
				<details
					className="session-activity"
					data-kind="fileChange"
					data-status={item.status}
					data-live={live ? "true" : undefined}
					data-nested={nested ? "true" : undefined}
					open
				>
					<summary>
						<ActivityIcon glyph="edit" />
						<span className={titleClass}>{title}</span>
						{counts}
						<ChevronRight size={12} className="session-activity-chevron" />
						{progress}
					</summary>
					{item.changes.map((change) => (
						<p className="session-file-change-row" key={change.path}>
							<FileMentionButton
								path={change.path}
								name={fileBasename(change.path)}
								change={change.change}
								onOpenFile={onOpenFile}
							/>
							<FileChangeCounts
								additions={change.additions}
								deletions={change.deletions}
							/>
						</p>
					))}
				</details>
			);
		}
		case "mcpToolCall":
			return (
				<div
					className="session-activity"
					data-kind="mcpToolCall"
					data-status={item.status}
					data-live={live ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph="mcp" />
						<span className={titleClass}>
							{item.server} · {item.tool}
						</span>
						{activityStatus(item.status)}
					</p>
				</div>
			);
		case "dynamicToolCall": {
			const check = checkSummary(item);
			if (check) return <CheckVerdictCard summary={check} nested={nested} />;
			const agent = agentCall(item);
			if (agent)
				return (
					<AgentCallView
						item={item}
						call={agent}
						titleClass={titleClass}
						nested={nested}
						live={live}
						onOpenFile={onOpenFile}
					/>
				);
			const command = toolCommand(item);
			const activity = toolActivity(item);
			// A run_code program: one card listing its inner calls as ordinary tool cards.
			const program = codeModeProgram(item);
			const codeResult = codeModeResult(item);
			const innerCalls = codeModeCallItems(item);
			return (
				<details
					className="session-activity"
					data-kind="dynamicToolCall"
					data-status={item.status}
					data-live={live ? "true" : undefined}
					data-nested={nested ? "true" : undefined}
				>
					<summary>
						<ActivityIcon
							glyph={
								item.status === "failed"
									? "error"
									: (activity.glyph ?? activityGlyphForToolName(item.tool))
							}
						/>
						<span className={titleClass} title={toolDetailTitle(item)}>
							<span className="session-tool-verb">{activity.verb}</span>
							{activity.target ? (
								activity.code ? (
									<code className="session-tool-target">{activity.target}</code>
								) : (
									<span className="session-tool-target">{activity.target}</span>
								)
							) : null}
							{activity.added || activity.removed ? (
								<span className="session-tool-stats">
									<span data-sign="added">+{activity.added ?? 0}</span>
									<span data-sign="removed">−{activity.removed ?? 0}</span>
								</span>
							) : null}
							{activity.note ? (
								<span className="session-tool-note">{activity.note}</span>
							) : null}
						</span>
						{item.background ? (
							<BackgroundCommandTag record={item.background} />
						) : null}
						<ChevronRight size={12} className="session-activity-chevron" />
						{item.background ? null : activityStatus(item.status)}
					</summary>
					{item.input &&
						(program !== null ? (
							<details className="session-command-detail session-program">
								<summary>
									<span className="session-activity-meta">
										{programLinesLabel(program)}
									</span>
									<ChevronRight
										size={12}
										className="session-activity-chevron"
									/>
								</summary>
								<pre className="session-output">{program}</pre>
							</details>
						) : (
							<div className="session-command-detail">
								<p className="session-activity-meta">Input</p>
								{command ? (
									<ShellCommandCode command={command} />
								) : (
									<ToolInputFields input={item.input} />
								)}
							</div>
						))}
					{innerCalls.length > 0 && (
						<div className="session-command-detail">
							<p className="session-activity-meta">
								{`${innerCalls.length} tool ${innerCalls.length === 1 ? "call" : "calls"}`}
							</p>
							{innerCalls.map((call) => (
								<SessionItemView
									key={call.id}
									item={call}
									nested
									fileChanges={fileChanges}
									onOpenFile={onOpenFile}
								/>
							))}
						</div>
					)}
					{codeResult ? (
						<div className="session-command-detail">
							<p className="session-activity-meta">Result</p>
							<pre className="session-output">
								{[
									codeResult.error
										? `Program failed: ${codeResult.error}`
										: (codeResult.result ?? "(no return value)"),
									codeResult.console ? `Console:\n${codeResult.console}` : "",
								]
									.filter(Boolean)
									.join("\n\n")}
							</pre>
						</div>
					) : (
						item.output && (
							<div className="session-command-detail">
								<p className="session-activity-meta">Result</p>
								<ToolInputFields input={toolOutputText(item.output)} />
							</div>
						)
					)}
					{!item.input && !item.output && (
						<p>Details were not recorded for this older call.</p>
					)}
				</details>
			);
		}
		case "webSearch":
			return (
				<div
					className="session-activity"
					data-kind="webSearch"
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph="web" />
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
						<ActivityIcon glyph="error" />
						<span className="session-activity-title">{item.message}</span>
					</p>
				</div>
			);
		case "modelSwitch":
			return (
				<div
					className="session-activity session-system-notice"
					data-kind="modelSwitch"
					data-reason={item.reason}
					role="status"
				>
					<p>
						<ActivityIcon glyph="switch" />
						<span className="session-activity-title" title={item.message}>
							{item.message}
						</span>
					</p>
				</div>
			);
		case "notice":
			return (
				<div
					className="session-activity session-system-notice"
					data-kind="notice"
					data-background={item.background ? "true" : undefined}
					role="status"
				>
					<p>
						{item.background ? (
							<SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
						) : (
							<ActivityIcon glyph="notice" />
						)}
						<span className="session-activity-title" title={item.message}>
							{item.message}
						</span>
					</p>
				</div>
			);
		case "unknown":
			return (
				<div
					className="session-activity"
					data-kind="unknown"
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph={activityGlyphForToolName(item.type)} />
						<span className="session-activity-title">{item.type}</span>
					</p>
				</div>
			);
	}
}

/** A background command's tag and live state: "Background · running 3m", "exited 0", "failed (exit 2)". */
function BackgroundCommandTag({ record }: { record: BackgroundCommandRecord }) {
	return (
		<span
			className="session-background-tag"
			data-state={backgroundCommandStatus(record)}
		>
			<Activity size={11} strokeWidth={1.5} aria-hidden="true" />
			{BACKGROUND_COMMAND_KIND_TAG}
			<span className="session-background-state">
				{backgroundCommandStateText(record, Date.now())}
			</span>
		</span>
	);
}

/** The running turn is compacting its context (the latest request's usage says so). */
function compactingContext(items: readonly SessionItem[]): boolean {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage")
			return item.contextUsage?.compacting === true;
	}
	return false;
}

function activityStatus(status: string) {
	const label = activityStatusLabel(status);
	return label ? (
		<span className="session-activity-status">{label}</span>
	) : null;
}

function activityTitleIsLive(
	item: SessionItem,
	turnRunning: boolean,
	thoughtInProgress: boolean,
): boolean {
	if (item.kind === "reasoning") {
		return turnRunning && thoughtInProgress && item.durationSeconds == null;
	}
	return turnRunning && liveActivityStatus(item) === "inProgress";
}

function activityStatusLabel(status: string): string | null {
	if (status === "failed") return "Failed";
	if (status === "declined") return "Declined";
	return null;
}

function programLinesLabel(program: string): string {
	const lines = program.split("\n").length;
	return `Program · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** A proposed plan reads as the agent's reply; the user answers it in the chat. */
function PlanMessage({
	text,
	onOpenFile,
}: {
	text: string;
	onOpenFile?: (path: string) => void;
}) {
	return (
		<div className="session-message" data-role="assistant" data-plan="true">
			<AgentMarkdown text={text} onOpenFile={onOpenFile} />
		</div>
	);
}
