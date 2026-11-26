import { ChevronRight, Clock3, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import {
	createContext,
	memo,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { agentCall } from "#/domain/agent-call";
import {
	MAIN_MENTION_ID,
	type MentionAgent,
	mentionAgents,
} from "#/domain/agent-mentions";
import {
	helperFinishCard,
	helperKind,
	helperMetric,
	helperStatus,
	LEAD_ROW_ID,
	steeringSender,
} from "#/domain/agent-panel";
import { visibleErrorMessage } from "#/domain/api-turn-failure";
import {
	type BackgroundCommandRecord,
	backgroundCommandStateText,
	backgroundCommandStatus,
} from "#/domain/background-command";
import { latestCanvasRevision } from "#/domain/canvas";
import { checkSummary } from "#/domain/check-summary";
import {
	type AgentTaskActivity,
	childTaskAnchorId,
	childTaskPublicItems,
	startsTurn,
	turnStartTiming,
	withoutWakeTurnStarts,
} from "#/domain/child-task-activity";
import {
	codeModeCallItems,
	codeModeProgram,
	codeModeResult,
} from "#/domain/code-mode";
import { commandActivityTitle } from "#/domain/command-activity-title";
import { mcpServerLabel, mcpToolLabel } from "#/domain/connector-name";
import { fileChangeTotals } from "#/domain/diff-preview";
import { isSetupRequestMessage } from "#/domain/environment-setup";
import {
	fileChangeActivity,
	fileChangeActivityTitle,
} from "#/domain/file-change-copy";
import { fileBasename } from "#/domain/file-kind";
import { helperFinishAnchors } from "#/domain/helper-finish-placement";
import {
	agentColor,
	HELPER_COLORS,
	type HelperIdentity,
	helperName,
	KIND_ICONS,
	KIND_TAGS,
} from "#/domain/helper-names";
import { mcpResult } from "#/domain/mcp-call-view";
import { isPastedText } from "#/domain/pasted-text";
import { pushApprovalOutcome } from "#/domain/push-approval";
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
import { thoughtLabel } from "#/domain/thought-label";
import { parsePeerMessage, peerSenderLabel } from "#/domain/thread-peer";
import {
	commandsLabel,
	explorationGroupIsLive,
	explorationLabel,
	groupExplorationRows,
	groupTimelineRows,
	type TimelineRow,
} from "#/domain/timeline-activity";
import { type RowKeyMemory, timelineRowKeys } from "#/domain/timeline-row-keys";
import { toolActivity, toolDetailTitle } from "#/domain/tool-detail";
import {
	reuseUnchangedItems,
	reuseUnchangedRows,
	sameJsonValue,
} from "#/domain/unchanged-items";
import { userQuestionReply } from "#/domain/user-question";
import {
	SetupProjectContext,
	SetupRequestItem,
	SetupRequestRow,
} from "#/features/projects/environment-build-progress";
import { useAutoGrow } from "../app/use-auto-grow";
import { CanvasCard, MemoCanvasCard } from "../canvas/canvas-card";
import {
	type CanvasFocus,
	CanvasOpenContext,
} from "../canvas/canvas-open-context";
import { HandoffCard } from "../local-import/handoff-card";
import { ActivityIcon } from "./activity-icon";
import {
	AgentMentionContext,
	type AgentMentions,
	AgentNameText,
	MentionText,
} from "./agent-chip";
import { AgentIcon } from "./agent-icon";
import { AgentMarkdown } from "./agent-markdown";
import {
	FileTile,
	type PastedTextPreview,
	PastedTextReader,
	PastedTextTile,
} from "./attachment-tile";
import { FileChangeCounts } from "./file-change-counts";
import { FileMentionButton } from "./file-mention";
import { InlineMarkdown } from "./inline-markdown";
import { LazyDetails } from "./lazy-details";
import { LiveCollapsible } from "./live-collapsible";
import { McpServerIcon } from "./mcp-server-icon";
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
import { PullRequestHandoffRow } from "./pull-request-handoff-row";
import {
	type PushApprovalActions,
	PushApprovalCard,
} from "./push-approval-card";
import {
	type SecretRequestActions,
	SecretRequestCard,
} from "./secret-request-card";
import { ReplyMarkdown } from "./settled-markdown";
import { ShellCommandCode } from "./shell-command-code";
import { useSmoothText } from "./smooth-text";
import { useStableActions, useStableCallback } from "./stable-callbacks";
import { StartingTurn } from "./starting-turn";
import { TodoList } from "./todo-list";
import {
	AgentCallView,
	CheckVerdictCard,
	RequirementsList,
} from "./tool-cards";
import {
	CommandOutput,
	ProgramSource,
	ToolDetailBody,
} from "./tool-detail-body";
import {
	type UserQuestionActions,
	UserQuestionCard,
} from "./user-question-card";
import { type TranscriptEntry, VirtualTranscript } from "./virtual-transcript";

export function SessionTimeline({
	items: allItems,
	turnStatus,
	fill = false,
	onOpenFile,
	onOpenCanvas,
	tasks = [],
	taskParentId,
	autoScroll = true,
	collapseInstructions = false,
	recoveryControls,
	secretActions,
	pushActions,
	questionActions,
	failoverActions,
	memoryActions,
	onRemoveQueued,
	onEditQueued,
	onSendQueued,
	stopping = false,
	helperLines,
	senderName,
	queuedSteering = [],
	readPastedText,
	olderItems,
	trailing,
	setupProjectId,
}: {
	/**
	 * Shown after everything else: a message waiting for the project's setup,
	 * with the setup's progress (workspace-home.tsx).
	 */
	trailing?: ReactNode;
	/** The chat's project: a setup chat shows its build under the setup's request. */
	setupProjectId?: string;
	/**
	 * The chat holds turns before `items`: they load as the reader nears the
	 * top, and the message being read stays where it is.
	 */
	olderItems?: { readonly loading: boolean; readonly onLoad: () => void };
	/** Loads a sent message's pasted text for its chip's preview. */
	readPastedText?: (attachmentId: string) => Promise<PastedTextPreview>;
	/**
	 * The chat's helpers by session id, with their agents-list names and
	 * colours: a thin line marks where each started and where it finished;
	 * clicking one opens its conversation.
	 */
	helperLines?: HelperLines;
	/** A helper's own view: messages in its transcript come from this sender (or the user). */
	senderName?: string;
	/** A helper's own view: steering its next step has not taken yet. */
	queuedSteering?: readonly {
		readonly id: string;
		readonly from: string;
		readonly text: string;
	}[];
	/** The user pressed Stop and the turn has not settled yet: queued messages say so. */
	stopping?: boolean;
	/** Takes back a message still waiting behind the running turn. */
	onRemoveQueued?: (messageId: string) => void;
	/** Replaces a waiting message's text. */
	onEditQueued?: (messageId: string, text: string) => void;
	/** Delivers a waiting message after the current step, or now if the turn ended. */
	onSendQueued?: (messageId: string, text?: string) => void;
	/** Opens, undoes and checks the memory lines a turn recalled or saved. */
	memoryActions?: MemoryMarkerActions;
	/** Save or skip a secret the agent asked for; omitted where nobody can answer. */
	secretActions?: SecretRequestActions;
	/** Approve or cancel a push to the default branch; omitted where nobody can answer. */
	pushActions?: PushApprovalActions;
	/** Answer the agent's question card; omitted where nobody can answer. */
	questionActions?: UserQuestionActions;
	/** Continue on the fallback a paused turn offers; omitted where nobody can answer. */
	failoverActions?: FailoverActions;
	recoveryControls?: (messageId: string) => ReactNode;
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	fill?: boolean;
	onOpenFile?: (path: string) => void;
	/** Opens a canvas card's canvas in the right panel; cards have no Open without it. */
	onOpenCanvas?: (focus: CanvasFocus) => void;
	tasks?: readonly AgentTaskActivity[];
	taskParentId?: string;
	autoScroll?: boolean;
	collapseInstructions?: boolean;
}) {
	// Derived once per transcript change, not per render (the composer's
	// typing renders this again). Each progress snapshot arrives as new
	// objects: the items, rows and file list that hold the same data stay the
	// previous objects, so only the rows that changed are drawn again.
	const previous = useRef<TimelineRows | null>(null);
	const derived = useMemo(
		() => stableTimelineRows(previous.current, allItems, turnStatus),
		[allItems, turnStatus],
	);
	previous.current = derived;
	const { queued, items, presented, visible, rows, rowKeys, fileChanges } =
		derived;
	const openFile = useStableCallback(onOpenFile);
	const openCanvas = useStableCallback(onOpenCanvas);
	const removeQueued = useStableCallback(onRemoveQueued);
	const editQueued = useStableCallback(onEditQueued);
	const sendQueued = useStableCallback(onSendQueued);
	const readPasted = useStableCallback(readPastedText);
	const stableMemoryActions = useStableActions(memoryActions);
	const stableSecretActions = useStableActions(secretActions);
	const stablePushActions = useStableActions(pushActions);
	const stableQuestionActions = useStableActions(questionActions);
	const stableFailoverActions = useStableActions(failoverActions);
	// The same while the helpers are: a new value would give every reply's
	// Markdown new components, and React would build their DOM again.
	const selectHelper = useRef(helperLines?.onSelect);
	selectHelper.current = helperLines?.onSelect;
	const identities = helperLines?.identities;
	const selectable = Boolean(helperLines?.onSelect);
	const stableHelperLines = useMemo<HelperLines | undefined>(
		() =>
			identities
				? {
						identities,
						...(selectable
							? { onSelect: (id: string) => selectHelper.current?.(id) }
							: {}),
					}
				: undefined,
		[identities, selectable],
	);
	const mentions = useMemo(
		() => agentMentions(stableHelperLines, taskParentId),
		[stableHelperLines, taskParentId],
	);
	const childTasks = tasks.filter((task) =>
		taskParentId ? task.parentSessionId === taskParentId : task.depth === 1,
	);
	const finishes = helperFinishAnchors({
		items: presented,
		rows,
		reportsWake: !taskParentId,
		helpers: childTasks
			.filter((task) => task.status === "done" || task.status === "failed")
			.map((task) => ({
				id: task.id,
				start: childTaskAnchorId(task, visible),
				finishedAt: helperMetric(task).endedAt,
			})),
	});
	const helperMarks = childTasks
		.map((task) => ({
			task,
			start: childTaskAnchorId(task, visible),
			// null: last, where the report's wake-up turn will show.
			finish: finishes.get(task.id),
		}))
		// A helper started in a turn not loaded yet shows with that turn.
		.filter((mark) => mark.start || !olderItems);
	// A helper's start line stands in for the agent call that started it.
	const startsHelper = (row: TimelineRow) =>
		!!stableHelperLines &&
		row.kind === "item" &&
		row.item.kind === "dynamicToolCall" &&
		row.item.tool === "agent" &&
		helperMarks.some((mark) => mark.start === row.item.id);
	const rowHas = (row: TimelineRow, id: SessionItem["id"] | null | undefined) =>
		!!id &&
		(row.kind === "item"
			? row.item.id === id
			: row.items.some((item) => item.id === id));
	const currentTurnIds = new Set<SessionItem["id"]>();
	for (const item of presented) {
		if (startsTurn(item)) currentTurnIds.clear();
		else currentTurnIds.add(item.id);
	}

	if (
		visible.length === 0 &&
		queued.length === 0 &&
		childTasks.length === 0 &&
		turnStatus !== "running" &&
		!trailing &&
		!fill
	)
		return null;

	// Each row of the list, in order; the list mounts only those near the view.
	const entries: TranscriptEntry[] = [];
	type Quiet = {
		readonly group: "started" | "finished";
		readonly entry: Omit<TranscriptEntry, "follows">;
		/** A helper that failed or never got going: counted in its row's title. */
		readonly failed?: boolean;
	};
	const quiet: Quiet[] = [];
	const append = (entry: Omit<TranscriptEntry, "follows">) =>
		entries.push({ ...entry, follows: entries.at(-1)?.kind });
	// Runs of helper starts, and runs of finished helpers, fold into one row
	// each, so a burst of helpers never pushes the reply out of view.
	const flushQuiet = () => {
		const queued = quiet.splice(0);
		for (let from = 0; from < queued.length; ) {
			let to = from;
			while (queued[to + 1]?.group === queued[from]?.group) to += 1;
			const run = queued.slice(from, to + 1);
			const entry = helperRunEntry(
				run.map((item) => item.entry),
				run[0]?.group ?? "started",
				run.filter((item) => item.failed).length,
			);
			if (entry) append(entry);
			from = to + 1;
		}
	};
	const add = (entry: Omit<TranscriptEntry, "follows">) => {
		flushQuiet();
		append(entry);
	};
	const queueLaunch = (entry: Omit<TranscriptEntry, "follows">) =>
		quiet.push({ group: "started", entry });
	const addHelperStart = (task: AgentTaskActivity) => {
		quiet.push({
			group: "started",
			entry: helperStartEntry(task, stableHelperLines),
			failed: task.status === "failed",
		});
	};
	const addHelperFinish = (task: AgentTaskActivity) => {
		// Failures fold too (a wall of "Couldn't start" cards is the clutter);
		// their row's title says how many, and each card is inside it.
		quiet.push({
			group: "finished",
			entry: helperFinishEntry(task, stableHelperLines),
			failed: task.status === "failed",
		});
	};
	for (const row of rows) {
		const rowId = row.kind === "item" ? row.item.id : row.id;
		const addRow = isLaunchNotice(row) ? queueLaunch : add;
		if (!startsHelper(row))
			addRow({
				key:
					rowKeys.get(row) ??
					(row.kind === "item" ? row.item.id : `${row.kind}:${row.id}`),
				kind: row.kind === "item" ? row.item.kind : row.kind,
				row: rowId,
				estimate: rowEstimate(row),
				content: (
					<>
						{row.kind === "item" && row.item.kind === "planProposal" ? (
							<PlanMessage text={row.item.text} onOpenFile={openFile} />
						) : row.kind === "item" && row.item.kind === "userQuestion" ? (
							<MemoUserQuestionCard
								item={row.item}
								reply={userQuestionReply(items, row.item.id)}
								actions={stableQuestionActions}
							/>
						) : row.kind === "item" && row.item.kind === "secretRequest" ? (
							<MemoSecretRequestCard
								item={row.item}
								outcome={secretRequestOutcome(items, row.item.id)}
								actions={stableSecretActions}
							/>
						) : row.kind === "item" && row.item.kind === "canvas" ? (
							<MemoCanvasCard
								item={row.item}
								latest={
									latestCanvasRevision(items, row.item.title) ===
									row.item.revision
								}
							/>
						) : row.kind === "item" && row.item.kind === "pushApproval" ? (
							<MemoPushApprovalCard
								item={row.item}
								outcome={pushApprovalOutcome(items, row.item.id)}
								actions={stablePushActions}
								revision={`${items.length}:${turnStatus}`}
							/>
						) : row.kind === "item" &&
							row.item.kind === "modelSwitch" &&
							row.item.state === "awaitingApproval" ? (
							<MemoModelSwitchCard
								item={row.item}
								answered={answeredAfter(items, row.item.id)}
								actions={stableFailoverActions}
							/>
						) : (
							<TimelineRowView
								row={row}
								collapseInstructions={collapseInstructions}
								turnRunning={
									turnStatus === "running" && currentTurnIds.has(rowId)
								}
								isLastItem={
									(row.kind === "item" ? row.item.id : row.items.at(-1)?.id) ===
									visible.at(-1)?.id
								}
								fileChanges={fileChanges}
								onOpenFile={openFile}
							/>
						)}
						{row.kind === "item" &&
						row.item.kind === "userMessage" &&
						recoveryControls ? (
							<RecoveryControls
								messageId={row.item.id}
								render={recoveryControls}
							/>
						) : null}
					</>
				),
			});
		for (const { task } of helperMarks.filter((mark) =>
			rowHas(row, mark.start),
		))
			addHelperStart(task);
		for (const { task } of helperMarks.filter((mark) =>
			rowHas(row, mark.finish),
		))
			addHelperFinish(task);
	}
	for (const { task } of helperMarks.filter((mark) => !mark.start))
		addHelperStart(task);
	for (const { task } of helperMarks.filter((mark) => mark.finish === null))
		addHelperFinish(task);
	const lastItem = presented.at(-1);
	const awaitingFirstActivity = !lastItem || startsTurn(lastItem);
	if (showTurnWorking(presented, turnStatus))
		add({
			key: "working",
			kind: "working",
			estimate: 30,
			content: awaitingFirstActivity ? (
				<StartingTurn
					key={lastItem?.id ?? "empty"}
					startedAt={
						lastItem ? turnStartTiming(lastItem)?.startedAt : undefined
					}
				/>
			) : (
				<p className="session-working session-shimmer">
					{compactingContext(items) ? "Compacting context" : "Thinking"}
				</p>
			),
		});
	for (const item of queued)
		add({
			key: item.id,
			kind: "userMessage",
			queued: true,
			estimate: 60,
			content: (
				<QueuedMessage
					item={item}
					stopping={stopping}
					onRemove={removeQueued}
					onEdit={editQueued}
					onSend={sendQueued}
				/>
			),
		});
	for (const message of queuedSteering)
		add({
			key: message.id,
			kind: "userMessage",
			queued: true,
			estimate: 60,
			content: (
				<div
					className="session-message"
					data-role="user"
					data-queued="true"
					data-sender="true"
				>
					<span className="session-message-sender">
						{message.from}
						<span className="session-queued-badge">Queued</span>
					</span>
					<p>
						<MentionText text={message.text} />
					</p>
				</div>
			),
		});
	if (
		turnStatus !== "running" &&
		childTasks.some((task) => task.turnStatus === "running")
	)
		add({
			key: "waiting-for-children",
			kind: "waiting-for-children",
			estimate: 30,
			content: (
				<p className="session-working" role="status">
					Waiting for helpers
				</p>
			),
		});
	if (trailing)
		add({
			key: "environment-setup",
			kind: "environment-setup",
			estimate: 220,
			content: trailing,
		});
	flushQuiet();

	return (
		<TimelineProviders
			memoryActions={stableMemoryActions}
			readPastedText={readPasted}
			setupProjectId={setupProjectId}
			openCanvas={openCanvas}
		>
			<SenderContext.Provider value={senderName ?? null}>
				<AgentMentionContext.Provider value={mentions}>
					<VirtualTranscript
						entries={entries}
						first={
							olderItems
								? {
										kind: "older",
										height: OLDER_ROW_HEIGHT,
										content: olderItems.loading ? (
											<LoaderCircle size={14} aria-label="Loading" />
										) : null,
									}
								: undefined
						}
						followEnd={autoScroll}
						followKey={
							trailing
								? "environment-setup"
								: (queued.at(-1)?.id ?? sentMessageId(presented))
						}
						onNearStart={
							olderItems && !olderItems.loading ? olderItems.onLoad : undefined
						}
					/>
				</AgentMentionContext.Provider>
			</SenderContext.Provider>
		</TimelineProviders>
	);
}

type TimelineRows = ReturnType<typeof timelineRows> & {
	readonly input: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	/** Each row's key in the list: a group keeps its key as older items join it. */
	readonly rowKeys: ReadonlyMap<TimelineRow, string>;
	readonly keyMemory: RowKeyMemory;
};

/** timelineRows, keeping the previous objects for everything that holds the same data. */
function stableTimelineRows(
	previous: TimelineRows | null,
	allItems: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): TimelineRows {
	const input = previous
		? reuseUnchangedItems(previous.input, allItems)
		: allItems;
	if (
		previous &&
		input === previous.input &&
		turnStatus === previous.turnStatus
	)
		return previous;
	const next = timelineRows(input, turnStatus, (presented) =>
		previous ? reuseUnchangedItems(previous.presented, presented) : presented,
	);
	const rows = previous
		? reuseUnchangedRows(previous.rows, next.rows)
		: next.rows;
	const { keys, memory } = timelineRowKeys(rows, previous?.keyMemory);
	return {
		...next,
		rows,
		fileChanges:
			previous && sameJsonValue(previous.fileChanges, next.fileChanges)
				? previous.fileChanges
				: next.fileChanges,
		input,
		turnStatus,
		rowKeys: keys,
		keyMemory: memory,
	};
}

function timelineRows(
	allItems: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
	settle: (presented: readonly SessionItem[]) => readonly SessionItem[] = (
		presented,
	) => presented,
) {
	// Waiting messages are not part of the turn yet; they sit below its activity.
	const queued = allItems.filter(isQueuedUserMessage);
	const items = queued.length
		? allItems.filter((item) => !isQueuedUserMessage(item))
		: allItems;
	// Wake-up turn starts stay in for grouping: they end the turn before them.
	const presented = settle(childTaskPublicItems(compactTimelineItems(items)));
	return {
		queued,
		items,
		presented,
		visible: withoutWakeTurnStarts(presented),
		rows: groupTimelineRows(presented, turnStatus),
		fileChanges: fileChangesFromSessionItems(items),
	};
}

// Rows are drawn again only when their own data changes, not on every
// keystroke in the composer or every streamed chunk of another message.
const MemoUserQuestionCard = memo(UserQuestionCard);
const MemoSecretRequestCard = memo(SecretRequestCard);
const MemoPushApprovalCard = memo(PushApprovalCard);
const MemoModelSwitchCard = memo(ModelSwitchCard);

/** A user message's recovery controls, drawn again when the controls change. */
const RecoveryControls = memo(function RecoveryControls({
	messageId,
	render,
}: {
	messageId: string;
	render: (messageId: string) => ReactNode;
}) {
	return render(messageId);
});

/** The last message the reader sent: sending one brings the list back to its end. */
function sentMessageId(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage") return item.id;
	}
	return undefined;
}

/** The row above a chat's loaded turns while it holds older ones (px, styled to match). */
const OLDER_ROW_HEIGHT = 28;

function isLaunchNotice(row: TimelineRow) {
	if (row.kind !== "item" || row.item.kind !== "dynamicToolCall") return false;
	if (row.item.tool !== "agent" || row.item.status !== "completed")
		return false;
	const call = agentCall(row.item);
	return !!call && !call.explore && !call.report;
}

function helperRunEntry(
	notices: readonly Omit<TranscriptEntry, "follows">[],
	group: "started" | "finished",
	failed = 0,
): Omit<TranscriptEntry, "follows"> | undefined {
	const first = notices[0];
	if (!first || notices.length === 1) return first;
	return {
		key: first.key,
		kind: "helper-launches",
		estimate: 26,
		content: (
			<LazyDetails className="helper-launches">
				<summary className="helper-line">
					<ChevronRight
						size={14}
						strokeWidth={1.5}
						className="session-activity-chevron"
					/>
					{`${notices.length} helpers ${group}${failed ? ` · ${failed} failed` : ""}`}
				</summary>
				<div>
					{notices.map((notice) => (
						<div key={notice.key}>{notice.content}</div>
					))}
				</div>
			</LazyDetails>
		),
	};
}

function helperStartEntry(
	task: AgentTaskActivity,
	lines: HelperLines | undefined,
): Omit<TranscriptEntry, "follows"> {
	return {
		key: `start:${task.id}`,
		kind: "helper-start",
		estimate: 28,
		content: <HelperLine task={task} lines={lines} />,
	};
}

function helperFinishEntry(
	task: AgentTaskActivity,
	lines: HelperLines | undefined,
): Omit<TranscriptEntry, "follows"> {
	return {
		key: `finish:${task.id}`,
		kind: "helper-finish",
		estimate: 120,
		content: <HelperFinishCard task={task} lines={lines} />,
	};
}

/**
 * A row's height (px, with its margins) until it is measured: text by its
 * length, tool rows as one line. It sizes only the space for rows not
 * mounted; mounted rows take their real height.
 */
function rowEstimate(row: TimelineRow): number {
	if (row.kind !== "item") return 40;
	const item = row.item;
	if (item.kind === "userMessage") return 44 + 18 * textLines(item.text, 90);
	if (item.kind === "agentMessage")
		return Math.min(14 + 20 * textLines(item.text, 100), 6_000);
	if (item.kind === "plan" && item.todos)
		return Math.min(60 + 28 * item.todos.length, 3_000);
	if (item.kind === "planProposal" || item.kind === "plan")
		return Math.min(60 + 20 * textLines(item.text, 100), 3_000);
	if (
		item.kind === "userQuestion" ||
		item.kind === "secretRequest" ||
		item.kind === "pushApproval"
	)
		return 160;
	if (item.kind === "canvas") return 100;
	return 34;
}

function textLines(text: string, perLine: number) {
	let lines = 0;
	for (const line of text.split("\n"))
		lines += Math.max(1, Math.ceil(line.length / perLine));
	return lines;
}

function TimelineProviders({
	memoryActions,
	readPastedText,
	setupProjectId,
	openCanvas,
	children,
}: {
	memoryActions?: MemoryMarkerActions;
	readPastedText?: (attachmentId: string) => Promise<PastedTextPreview>;
	setupProjectId?: string;
	openCanvas?: (focus: CanvasFocus) => void;
	children: ReactNode;
}) {
	return (
		<MemoryMarkerProvider actions={memoryActions}>
			<PastedTextReader.Provider value={readPastedText ?? null}>
				<SetupProjectContext.Provider value={setupProjectId ?? null}>
					<CanvasOpenContext.Provider value={openCanvas ?? null}>
						{children}
					</CanvasOpenContext.Provider>
				</SetupProjectContext.Provider>
			</PastedTextReader.Provider>
		</MemoryMarkerProvider>
	);
}

/** Short names, tasks and colours of a chat's helpers, and how to open one. */
export type HelperLines = {
	readonly identities: ReadonlyMap<
		string,
		Pick<HelperIdentity, "name" | "task" | "color" | "icon">
	>;
	readonly onSelect?: (helperId: string) => void;
};

/** A helper's view names who sent each message in its transcript. */
const SenderContext = createContext<string | null>(null);

/**
 * The agents a view's messages can name as chips: the chat's agents but the
 * view's own (Main's, or the helper's), each opening its tab.
 */
function agentMentions(
	lines: HelperLines | undefined,
	viewAgentId: string | undefined,
): AgentMentions | null {
	if (!lines) return null;
	const onSelect = lines.onSelect;
	return {
		agents: mentionAgents(lines.identities, viewAgentId ?? MAIN_MENTION_ID),
		...(onSelect
			? {
					onOpen: (agent: MentionAgent) =>
						onSelect(agent.id === MAIN_MENTION_ID ? LEAD_ROW_ID : agent.id),
				}
			: {}),
	};
}

/** "build-1 started · Fix pricing rounding": one quiet line where it started. */
const HelperLine = memo(function HelperLine({
	task,
	lines,
}: {
	task: AgentTaskActivity;
	lines?: HelperLines;
}) {
	const identity = lines?.identities.get(task.id);
	const name = identity?.name ?? helperName(task.title);
	const kind = helperKind(task);
	const content = (
		<>
			<AgentIcon
				icon={identity?.icon ?? KIND_ICONS[kind]}
				color={identity?.color ?? HELPER_COLORS[0]}
				size={14}
			/>
			<span className="helper-line-name">{name}</span>
			<span className="helper-line-text" title={task.title}>
				started · {identity?.task ?? helperName(task.title)}
			</span>
		</>
	);
	return lines?.onSelect ? (
		<button
			type="button"
			className="helper-line"
			data-status={helperStatus(task.status)}
			title={`Open ${name}`}
			onClick={() => lines.onSelect?.(task.id)}
		>
			{content}
		</button>
	) : (
		<p className="helper-line" data-status={helperStatus(task.status)}>
			{content}
		</p>
	);
});

/**
 * A finished helper in its parent's chat: an outlined card with its name,
 * outcome, task and time over its report's first line. The full report is
 * its hover; a click opens the helper, as its agents-list row does.
 */
const HelperFinishCard = memo(function HelperFinishCard({
	task,
	lines,
}: {
	task: AgentTaskActivity;
	lines?: HelperLines;
}) {
	const identity = lines?.identities.get(task.id);
	const card = helperFinishCard(task, identity);
	const kind = helperKind(task);
	const content = (
		<>
			<span className="helper-card-head">
				<AgentIcon
					icon={identity?.icon ?? KIND_ICONS[kind]}
					color={identity?.color ?? HELPER_COLORS[0]}
					size={14}
				/>
				<span className="helper-card-name">{card.name}</span>
				<span className="helper-card-task">
					<span className="helper-card-verb" data-verb={card.verb}>
						{card.label}
					</span>
					{` · ${card.task}`}
				</span>
				{card.duration ? (
					<span className="helper-card-time">{card.duration}</span>
				) : null}
			</span>
			{card.line ? (
				<span className="helper-card-line">
					<InlineMarkdown
						text={card.line}
						renderText={(text) => <AgentNameText text={text} open={false} />}
					/>
				</span>
			) : null}
		</>
	);
	return lines?.onSelect ? (
		<button
			type="button"
			className="helper-card"
			data-status={card.verb}
			title={card.detail || `Open ${card.name}`}
			onClick={() => lines.onSelect?.(task.id)}
		>
			{content}
		</button>
	) : (
		<div
			className="helper-card"
			data-status={card.verb}
			title={card.detail || undefined}
		>
			{content}
		</div>
	);
});

function MessageAttachments({
	attachments,
}: {
	attachments: UserMessageItem["attachments"];
}) {
	if (!attachments?.length) return null;
	return (
		<ul
			className="attachment-tiles"
			data-place="message"
			aria-label="Attached files"
		>
			{attachments.map((attachment) =>
				isPastedText(attachment) ? (
					<PastedTextTile
						key={attachment.id}
						attachmentId={attachment.id}
						lines={attachment.lines}
						peek={attachment.peek}
					/>
				) : (
					<FileTile
						key={attachment.id}
						name={attachment.name}
						mediaType={attachment.mediaType}
						size={attachment.size}
					/>
				),
			)}
		</ul>
	);
}

const QueuedMessage = memo(function QueuedMessage({
	item,
	stopping = false,
	onRemove,
	onEdit,
	onSend,
}: {
	item: UserMessageItem;
	stopping?: boolean;
	onRemove?: (messageId: string) => void;
	onEdit?: (messageId: string, text: string) => void;
	onSend?: (messageId: string, text?: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const editField = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(editField, draft ?? "");
	const editing = draft !== null;
	const shown = (draft ?? item.text).trim();
	// The setup's request waiting its turn: one line, not its paragraph.
	if (isSetupRequestMessage(item.text)) return <SetupRequestRow />;
	return (
		<div className="session-message" data-role="user" data-queued="true">
			<MessageAttachments attachments={item.attachments} />
			{editing ? (
				<textarea
					ref={editField}
					className="session-queued-edit"
					aria-label="Edit queued message"
					rows={Math.min(8, Math.max(2, draft.split("\n").length))}
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value)}
				/>
			) : (
				<p>
					<MentionText text={item.text} />
				</p>
			)}
			<p className="session-queued-note" role="status">
				<Clock3 size={14} strokeWidth={1.5} aria-hidden="true" />
				<span>
					{item.heldForSetup
						? "Waiting for setup"
						: stopping
							? "Stopping…"
							: item.released
								? "Sending now (after any running tool)"
								: "Queued in this chat"}
				</span>
				{onEdit ? (
					editing ? (
						<>
							<button
								type="button"
								className="session-queued-action"
								onClick={() => {
									if (!shown) return;
									onEdit(item.id, shown);
									setDraft(null);
								}}
							>
								Save
							</button>
							<button
								type="button"
								className="session-queued-action"
								onClick={() => setDraft(null)}
							>
								Cancel
							</button>
						</>
					) : (
						<button
							type="button"
							className="session-queued-action"
							aria-label="Edit queued message"
							onClick={() => setDraft(item.text)}
						>
							Edit
						</button>
					)
				) : null}
				{onSend && !item.heldForSetup && !item.released ? (
					<button
						type="button"
						className="session-queued-action"
						aria-label="Send queued message"
						title={
							item.released
								? "Sending now, after any running tool"
								: "Send now: the agent reads it right away, after any running tool"
						}
						disabled={!shown}
						onClick={() => {
							if (!shown) return;
							onSend(item.id, editing ? shown : undefined);
							setDraft(null);
						}}
					>
						Send
					</button>
				) : null}
				{onRemove ? (
					<button
						type="button"
						aria-label="Remove queued message"
						title="Remove this message before it is delivered"
						onClick={() => onRemove(item.id)}
					>
						<X size={14} strokeWidth={1.5} aria-hidden="true" />
					</button>
				) : null}
			</p>
		</div>
	);
});

const TimelineRowView = memo(function TimelineRowView({
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
			<LazyDetails className="session-work">
				<summary>
					<span title="Elapsed time from dispatch to observed completion">
						{row.label}
					</span>
					<ChevronRight
						size={14}
						strokeWidth={1.5}
						className="session-activity-chevron"
					/>
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
			</LazyDetails>
		);
	}
	if (row.kind === "exploration" || row.kind === "commands") {
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
						{row.kind === "commands"
							? commandsLabel(row.items)
							: explorationLabel(row.counts)}
					</span>
					<ChevronRight
						size={14}
						strokeWidth={1.5}
						className="session-activity-chevron"
					/>
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
});

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
	const sender = useContext(SenderContext);
	const live = activityTitleIsLive(item, turnRunning, thoughtInProgress);
	const titleClass = live
		? "session-activity-title session-shimmer"
		: "session-activity-title";
	switch (item.kind) {
		case "userMessage": {
			if (sender !== null) {
				const message = steeringSender(item.text, sender);
				return (
					<div className="session-message" data-role="user" data-sender="true">
						<span className="session-message-sender">{message.from}</span>
						{message.text.length > 600 ? (
							<LazyDetails className="session-work child-task-instructions">
								<summary>
									<span>{firstWords(message.text)}</span>
									<ChevronRight
										size={14}
										strokeWidth={1.5}
										className="session-activity-chevron"
									/>
								</summary>
								<div className="session-work-items">
									<AgentMarkdown text={message.text} onOpenFile={onOpenFile} />
								</div>
							</LazyDetails>
						) : (
							<p>
								<MentionText text={message.text} />
							</p>
						)}
					</div>
				);
			}
			if (collapseInstructions) {
				return (
					<LazyDetails className="session-work child-task-instructions">
						<summary>
							<span>Brief</span>
							<ChevronRight
								size={14}
								strokeWidth={1.5}
								className="session-activity-chevron"
							/>
						</summary>
						<div className="session-work-items">
							<AgentMarkdown text={item.text} onOpenFile={onOpenFile} />
						</div>
					</LazyDetails>
				);
			}
			// The setup's own request: one line and the build it ran after.
			if (isSetupRequestMessage(item.text)) return <SetupRequestItem />;
			const peer = parsePeerMessage(item.text);
			if (peer)
				return (
					<div className="session-message" data-role="user" data-peer="true">
						<span className="session-message-sender">
							From {peerSenderLabel(peer)}
						</span>
						<p>
							<MentionText text={peer.body} />
						</p>
					</div>
				);
			return (
				<div className="session-message" data-role="user">
					<MessageAttachments attachments={item.attachments} />
					<p>
						<MentionText text={item.text} />
					</p>
					{item.memory ? <MemoryRecallNote recall={item.memory} /> : null}
				</div>
			);
		}
		case "memorySave":
			return <MemorySaveNote item={item} />;
		case "agentMessage":
			return (
				<AgentReply
					id={item.id}
					text={item.text}
					streaming={Boolean(turnRunning && item.streaming)}
					fileChanges={fileChanges}
					onOpenFile={onOpenFile}
				/>
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
			// Thinking reads whole as text, however long: a row that has to be
			// opened to read the agent's words is not worth the click.
			return (
				<div
					className="session-activity session-narration"
					data-kind="reasoning"
					data-live={live ? "true" : undefined}
				>
					{summaries
						.flatMap((summary) => summary.split(/\n\s*\n/))
						.map((paragraph) => paragraph.trim().replace(/^#+\s*|\*\*/gm, ""))
						.filter(Boolean)
						.map((paragraph, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs can repeat; their order is their identity
							<p key={`${item.id}:${index}`}>
								<span className={titleClass}>{paragraph}</span>
							</p>
						))}
				</div>
			);
		}
		case "plan":
			if (item.todos) return <TodoList todos={item.todos} live={turnRunning} />;
			return (
				<LazyDetails className="session-activity" data-kind="plan">
					<summary>
						<ActivityIcon glyph="plan" />
						<span className="session-activity-title">Plan</span>
						<ChevronRight
							size={14}
							strokeWidth={1.5}
							className="session-activity-chevron"
						/>
					</summary>
					<p>{item.text || "Planning…"}</p>
				</LazyDetails>
			);
		case "userQuestion":
			return <UserQuestionCard item={item} reply={null} />;
		case "secretRequest":
			return <SecretRequestCard item={item} outcome="answered" />;
		case "pushApproval":
			return <PushApprovalCard item={item} outcome={{ answer: "pending" }} />;
		case "canvas":
			return <CanvasCard item={item} latest={false} />;
		case "planProposal":
			return <PlanMessage text={item.text} onOpenFile={onOpenFile} />;
		case "commandExecution": {
			const status = activityStatusLabel(item.status);
			return (
				<LazyDetails
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
						<ChevronRight
							size={14}
							strokeWidth={1.5}
							className="session-activity-chevron"
						/>
					</summary>
					<div className="session-command-detail">
						<ShellCommandCode command={item.command} />
						{item.output ? (
							<CommandOutput
								command={item.command}
								output={item.output}
								className="session-output"
							/>
						) : null}
						{item.exitCode !== null && item.exitCode !== 0 ? (
							<p className="session-activity-meta">Exit {item.exitCode}</p>
						) : null}
					</div>
				</LazyDetails>
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
				<LazyDetails
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
						<ChevronRight
							size={14}
							strokeWidth={1.5}
							className="session-activity-chevron"
						/>
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
				</LazyDetails>
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
						<McpServerIcon server={item.server} />
						<span className={titleClass}>
							<span className="session-tool-verb">
								{mcpServerLabel(item.server)}
							</span>
							<span className="session-tool-sep" aria-hidden="true">
								·
							</span>
							<span className="session-tool-target">
								{mcpToolLabel(item.tool, item.server)}
							</span>
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
			const activity = toolActivity(item);
			// A run_code program: one card listing its inner calls as ordinary tool cards.
			const program = codeModeProgram(item);
			const codeResult = codeModeResult(item);
			const innerCalls = codeModeCallItems(item);
			return (
				<LazyDetails
					className="session-activity"
					data-kind="dynamicToolCall"
					data-status={item.status}
					data-live={live ? "true" : undefined}
					data-nested={nested ? "true" : undefined}
					data-background={activity.background ? "true" : undefined}
				>
					<summary>
						{activity.background ? (
							<AgentIcon
								icon={KIND_ICONS.background}
								color={agentColor("background")}
							/>
						) : activity.mcpServer ? (
							<McpServerIcon server={activity.mcpServer} />
						) : (
							<ActivityIcon
								glyph={
									item.status === "failed"
										? "error"
										: (activity.glyph ?? activityGlyphForToolName(item.tool))
								}
							/>
						)}
						<span className={titleClass} title={toolDetailTitle(item)}>
							<span className="session-tool-verb">{activity.verb}</span>
							{activity.mcpServer && activity.target ? (
								<span className="session-tool-sep" aria-hidden="true">
									·
								</span>
							) : null}
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
									{activity.removed !== undefined ? (
										<span data-sign="removed">−{activity.removed}</span>
									) : null}
								</span>
							) : null}
							{activity.note ? (
								<span className="session-tool-note">{activity.note}</span>
							) : null}
							{activity.mcpServer && mcpResult(item.output)?.isError ? (
								<span className="session-tool-error">Error</span>
							) : null}
						</span>
						{activity.background ? (
							<BackgroundCommandTag record={item.background} />
						) : null}
						<ChevronRight
							size={14}
							strokeWidth={1.5}
							className="session-activity-chevron"
						/>
						{item.background ? null : activityStatus(item.status)}
					</summary>
					{program !== null ? (
						<>
							<LazyDetails
								className="tool-panel session-program"
								data-kind="program"
							>
								<summary className="tool-panel-head">
									<span className="tool-panel-title">
										<span className="tool-panel-meta">
											{programLinesLabel(program)}
										</span>
									</span>
									<ChevronRight
										size={14}
										strokeWidth={1.5}
										className="session-activity-chevron"
									/>
								</summary>
								<ProgramSource program={program} />
							</LazyDetails>
							{innerCalls.length > 0 && (
								<div className="session-program-calls">
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
							{codeResult &&
							(codeResult.error ||
								codeResult.console ||
								(codeResult.result && codeResult.result !== "null")) ? (
								<div className="tool-panel" data-kind="returned">
									<div className="tool-panel-head">
										<span className="tool-panel-title">
											<span className="tool-panel-meta">
												{codeResult.error ? "Program failed" : "Returned"}
											</span>
										</span>
									</div>
									<pre
										className="tool-panel-body tool-panel-output"
										data-tone={codeResult.error ? "bad" : undefined}
									>
										{[
											codeResult.error ?? codeResult.result ?? "",
											codeResult.console
												? `Console:\n${codeResult.console}`
												: "",
										]
											.filter(Boolean)
											.join("\n\n")}
									</pre>
								</div>
							) : null}
						</>
					) : (
						<ToolDetailBody item={item} />
					)}
				</LazyDetails>
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
						<span className="session-activity-title">
							{visibleErrorMessage(item)}
						</span>
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
			// A wake-up turn's silent start, where its answer would run on from
			// the previous one (groupTimelineRows): a quiet turn break.
			if (item.wake)
				return <hr className="session-turn-break" data-kind="wake" />;
			if (item.stopped)
				return (
					<p className="session-stopped" data-kind="stopped" role="status">
						{item.message}
					</p>
				);
			if (item.pullRequest) return <PullRequestHandoffRow item={item} />;
			if (item.goal)
				return (
					<p
						className="session-activity session-system-notice"
						data-kind="goal"
						role="status"
					>
						{item.message}
					</p>
				);
			if (item.startingMachine)
				return (
					<div
						className="session-activity session-system-notice"
						data-kind="starting-machine"
						role="status"
					>
						<p>
							<LoaderCircle
								size={14}
								className="workspace-status-spin"
								aria-hidden="true"
							/>
							<span className="session-activity-title">{item.message}</span>
						</p>
					</div>
				);
			if (item.savingChanges)
				return (
					<div
						className="session-activity session-system-notice"
						data-kind="saving-changes"
						role="status"
					>
						<p>
							<LoaderCircle
								size={14}
								className="workspace-status-spin"
								aria-hidden="true"
							/>
							<span className="session-activity-title">{item.message}</span>
						</p>
					</div>
				);
			return (
				<div
					className="session-activity session-system-notice"
					data-kind="notice"
					data-background={item.background ? "true" : undefined}
					role="status"
				>
					<p>
						{item.background ? (
							<AgentIcon
								icon={KIND_ICONS.background}
								color={agentColor("background")}
							/>
						) : (
							<ActivityIcon glyph="notice" />
						)}
						<span className="session-activity-title" title={item.message}>
							{item.message}
						</span>
					</p>
				</div>
			);
		case "handoff":
			// The local session's conversation is in the model's context; the
			// timeline shows a short summary of where it came from.
			return <HandoffCard item={item} />;
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

/** An agent's reply; while it streams, its text shows at a steady pace (useSmoothText). */
function AgentReply({
	id,
	text,
	streaming,
	fileChanges,
	onOpenFile,
}: {
	id: string;
	text: string;
	streaming: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	const shown = useSmoothText(text, streaming);
	return (
		<div
			className="session-message"
			data-role="assistant"
			data-streaming={streaming ? "true" : undefined}
		>
			{requirementsSegments(shown).map((segment, index) =>
				segment.kind === "requirements" ? (
					<RequirementsList
						// biome-ignore lint/suspicious/noArrayIndexKey: a message's segments keep their order
						key={index}
						items={segment.items}
					/>
				) : (
					<ReplyMarkdown
						// biome-ignore lint/suspicious/noArrayIndexKey: a message's segments keep their order
						key={index}
						segmentKey={`${id}:${index}`}
						text={segment.text}
						streaming={streaming}
						fileChanges={fileChanges}
						onOpenFile={onOpenFile}
					/>
				),
			)}
		</div>
	);
}

/**
 * A background command's kind tag (the agents list's, helper-names.ts) and,
 * when the command is recorded, its live state: "running 3m", "exited 0",
 * "failed (exit 2)".
 */
function BackgroundCommandTag({
	record,
}: {
	record: BackgroundCommandRecord | undefined;
}) {
	return (
		<span
			className="session-background-tag"
			data-state={record ? backgroundCommandStatus(record) : undefined}
		>
			<span className="agent-row-tag">{KIND_TAGS.background}</span>
			{record ? (
				<span className="session-background-state">
					{backgroundCommandStateText(record, Date.now())}
				</span>
			) : null}
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
const PlanMessage = memo(function PlanMessage({
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
});

/** The opening words of a long brief, for its folded summary. */
function firstWords(text: string) {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
