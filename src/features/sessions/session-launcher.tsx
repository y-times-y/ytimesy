import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUp, Square, Target } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { connectedProviderId } from "#/domain/agent-connection";
import {
	activeMention,
	insertMention,
	MAIN_MENTION_ID,
	type MentionAgent,
	mentionAgents,
	mentionMatches,
} from "#/domain/agent-mentions";
import {
	agentPanelRows,
	type BackgroundRun,
	helperIdentities,
	LEAD_ROW_ID,
} from "#/domain/agent-panel";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { parseSteering } from "#/domain/agent-steering";
import { recordedContextUsage } from "#/domain/api-progress";
import {
	type AgentTaskActivity,
	helperHasOlderItems,
} from "#/domain/child-task-activity";
import { isClaudeCodeRoute } from "#/domain/claude-code-route";
import {
	composerDraftKey,
	createDraftSaver,
	type DraftSaver,
	draftWithPrefill,
	loadComposerDraft,
	saveComposerDraft,
} from "#/domain/composer-drafts";
import { composerProjectNotice } from "#/domain/composer-project";
import { chosenContextWindow } from "#/domain/context-window-option";
import { activeGoal } from "#/domain/goal-notice";
import {
	canResumeDisconnectedFollowUp,
	composerCanStartSignIn,
	composerSendIsEnabled,
	harnessRequiresAccountLogin,
	selectedHarnessIsConnected,
} from "#/domain/harness-access";
import { MAIN_NAME } from "#/domain/helper-names";
import { SessionItemId } from "#/domain/ids";
import {
	shortcutMatches,
	titleWithShortcut,
} from "#/domain/keyboard-shortcuts";
import {
	composerModelIdForCatalog,
	listedModelDisplayName,
} from "#/domain/listed-model";
import {
	type IncomingAttachment,
	safeAttachmentName,
} from "#/domain/message-attachment";
import { FAILOVER_CONTINUE_TEXT } from "#/domain/model-failover";
import {
	isLargePaste,
	isPastedText,
	nextPastedTextNumber,
} from "#/domain/pasted-text";
import type { Project } from "#/domain/projects";
import { secretsAnsweredText } from "#/domain/secret-request";
import {
	blockedSendAttempt,
	type ComposerSendBlock,
	composerSendBlock,
} from "#/domain/send-blocked";
import {
	continuedChatAwaitsMessage,
	isQueuedUserMessage,
	lastUserMessageText,
	type SessionItem,
	type SessionTurnStatus,
	sessionUsesFollowUpLayout,
	visibleSessionItems,
} from "#/domain/session-item";
import { slashCommandOpensSideChat } from "#/domain/side-chat";
import {
	COMPACT_COMMAND_TEXT,
	composerSlashCommands,
	exactSlashCommand,
	expandProjectCommand,
	parseSlashDraft,
	type SlashCommand,
	slashMenuCommands,
} from "#/domain/slash-command";
import { turnSavingChanges } from "#/domain/turn-saving";
import { hubTopic } from "#/domain/user-hub";
import type { SettingsSection } from "#/domain/workspace-settings";
import {
	withoutClaudeCodeModels,
	Y_SQUARED_CLAUDE_CODE_NOTE,
} from "#/domain/y-squared";
import { captureAnalytics } from "#/features/analytics/client";
import { startInteraction } from "#/features/analytics/web-vitals";
import {
	useHydrated,
	useHydrating,
	useTypedBeforeHydration,
} from "#/features/app/first-paint";
import {
	currentShortcutPlatform,
	keyFocusOf,
	useShortcutHint,
} from "#/features/app/keyboard-shortcuts";
import { useHoldNewBuildReload } from "#/features/app/new-build-reload";
import { authClient } from "#/features/auth/client";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import type { OpenChatSide } from "#/server/services/open-chat-side";
import type { CanvasFocus } from "../canvas/canvas-open-context";
import { listProjectCommandsFn } from "../workspace/explorer.fn";
import { saveProjectSecretFn } from "../workspace/project-secrets.fn";
import {
	pollUnlessPushed,
	useHubDelivery,
	useHubRead,
} from "../workspace/user-hub-store";
import { AgentIcon } from "./agent-icon";
import { AgentPanel } from "./agent-panel";
import {
	getConversationForkStatus,
	getConversationRecoveryPoints,
	restoreConversationPoint,
	retryConversationForkFn,
	sendHelperMessage,
} from "./agent-session.fn";
import { attachmentLimitError, encodeAttachments } from "./attachment-encoding";
import {
	FileTile,
	PastedTextTile,
	pastedFileText,
	pastedTextFile,
	sentFileFields,
} from "./attachment-tile";
import { chatSideKeys } from "./chat-side-queries";
import { getClaudeSubscription } from "./claude-subscription.fn";
import { ContextUsage } from "./context-usage";
import {
	ConversationRecovery,
	ConversationRecoverySlot,
	refreshRecoveredWorkspace,
} from "./conversation-recovery";
import { ComposerSignIn } from "./harness-login";
import { MODEL_PICKER_ID } from "./harness-picker";
import type { MemoryMarkerActions } from "./memory-markers";
import { MentionPopover } from "./mention-popover";
import {
	type ComposerSpeed,
	composerListedModels,
	resolveReasoningLevel,
	sessionModelsFromListed,
} from "./model-capabilities";
import { getAgentModelCatalog } from "./model-catalog.fn";
import { readPastedTextFn } from "./pasted-text.fn";
import { useMarkPlanLimitFromSwitches } from "./plan-usage";
import { ProjectContext } from "./project-context";
import {
	cancelPushApprovalFn,
	pushApprovalStatusFn,
	pushApprovedChangeFn,
} from "./push-approval.fn";
import { SendBlockNotice } from "./send-block-notice";
import { SessionControls } from "./session-controls";
import { SessionTimeline } from "./session-timeline";
import { SideChatFrame, useSideChat } from "./side-chat-panel";
import { SlashCommandPalette } from "./slash-command-palette";
import { useStableCallback } from "./stable-callbacks";
import { TaskInput } from "./task-input";

type InspectorView = "files" | "diff" | "terminal" | "desktop" | "side";

const ATTACHMENTS_ONLY_TEXT = "See the attached files.";

export const COMPOSER_INPUT_ID = "composer-draft";
const SIDE_COMPOSER_INPUT_ID = "side-chat-draft";

/** How long typing pauses before the draft is saved for a reload. */
const DRAFT_SAVE_DELAY_MS = 300;

/**
 * How a composer send ended. `unsent` returns the message to this composer;
 * `unsentElsewhere` means the user had moved to another chat, whose composer
 * must not receive it.
 */
export type ComposerSendResult = "sent" | "unsent" | "unsentElsewhere";

export function SessionLauncher({
	session,
	busy,
	harnessId,
	onHarnessIdChange,
	onSend,
	onConnect,
	onStop,
	onOpenInspector,
	onOpenFile,
	onOpenCanvas,
	onRecovered,
	initialDraft = "",
	prefill,
	onPrefillSent,
	onSetUpEnvironment,
	childTasks = [],
	projects,
	selectedProject,
	onSelectProject,
	listedTitle,
	projectPickerOpen,
	onProjectPickerOpenChange,
	memoryActions,
	stopping,
	onRemoveQueued,
	onEditQueued,
	onSendQueued,
	backgroundRuns,
	onDraftStarted,
	olderItems,
	olderHelperItems,
	loadedCatalog,
	variant = "main",
	setupHold,
	onOpenSettings,
	setupPlaceholder,
	branchless = false,
	emptyState,
}: {
	/** A chat without a branch of its own (Y²): no branch pill or picker. */
	branchless?: boolean;
	/**
	 * Drawn instead of the transcript while the chat has no messages; `send`
	 * sends a message the way the message box does.
	 */
	emptyState?: (send: (text: string) => void) => ReactNode;
	/** The project's setup runs in the background: the empty composer says so. */
	setupPlaceholder?: string | null;
	/** Opens Settings at a section: the fix a blocked send points to. */
	onOpenSettings?: (section: SettingsSection) => void;
	/**
	 * A sent message waiting for the project's setup: drawn after the
	 * transcript, with the message itself unless the transcript has it.
	 */
	setupHold?: {
		readonly messageId: string;
		readonly render: (showMessage: boolean) => ReactNode;
	};
	/**
	 * "side": the composer beside Main in a side chat. Same transcript,
	 * composer and controls, without the project picker, helpers or /side.
	 */
	variant?: "main" | "side";
	/** The chat holds turns before those shown; they load as the reader scrolls up. */
	olderItems?: { readonly loading: boolean; readonly onLoad: () => void };
	/**
	 * A helper is read as its last page: its view loads older items as the
	 * reader nears the top (`loadingId` is the helper being read).
	 */
	olderHelperItems?: {
		readonly loadingId: string | null;
		readonly onLoad: (helperId: string) => void;
	};
	/**
	 * The model catalog the server read with the page's open chat: shown
	 * until the browser's own read of it lands, so the model button keeps
	 * its name and width as the page loads.
	 */
	loadedCatalog?: OpenChatSide["catalog"];
	/** The draft went from empty to some text (a new chat starts its machine then). */
	onDraftStarted?: () => void;
	/** Background commands this chat started (their read model), shown as list rows. */
	backgroundRuns?: readonly BackgroundRun[];
	/** Memory lines recalled or saved by this chat's turns: open, undo, check. */
	memoryActions?: MemoryMarkerActions;
	/** The user pressed Stop and the server has not settled the turn yet. */
	stopping?: boolean;
	/** Takes back a message still waiting behind the running turn. */
	onRemoveQueued?: (messageId: string) => void;
	/** Replaces a waiting message's text. */
	onEditQueued?: (messageId: string, text: string) => void;
	/** Delivers a waiting message after the current step, or now if the turn ended. */
	onSendQueued?: (messageId: string, text?: string) => void;
	session: PublicCodexSession;
	busy: boolean;
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	onSend: (
		text: string,
		modelId: string,
		options?: {
			readonly reasoningId?: string;
			readonly speed?: ComposerSpeed;
			/** The route's alternate context window; every send states it. */
			readonly alternateContext?: boolean;
			readonly approvesPlan?: boolean;
			/** Continue on the fallback route the user approved after an outage. */
			readonly continueOn?: string;
			readonly userMessageId?: string;
			readonly attachments?: readonly IncomingAttachment[];
			/** The branch a new chat starts from, when the person picked one. */
			readonly baseBranch?: string;
		},
	) => Promise<ComposerSendResult> | undefined;
	onConnect: () => void;
	onStop: () => void;
	onOpenInspector: (view: InspectorView) => void;
	onOpenFile?: (path: string) => void;
	/** Opens a canvas card's canvas in the right panel (Main's timeline only). */
	onOpenCanvas?: (focus: CanvasFocus) => void;
	onRecovered?: (
		sessionId: string,
		prompt: string | null,
		items: readonly SessionItem[] | null,
	) => Promise<void>;
	initialDraft?: string;
	/**
	 * Text put in the message box whenever `at` changes. With `send` it goes
	 * by itself once the chat can take it, without passing through the box
	 * (the setup's request), as `messageId` when given. With `append` it
	 * goes after what is already typed instead of replacing it.
	 */
	prefill?: {
		readonly text: string;
		readonly at: number;
		readonly send?: boolean;
		readonly messageId?: string;
		readonly append?: boolean;
	};
	/** A `send` prefill went (or showed why it cannot); the page drops it. */
	onPrefillSent?: () => void;
	onSetUpEnvironment?: () => void;
	childTasks?: readonly AgentTaskActivity[];
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	listedTitle?: string;
	projectPickerOpen?: boolean;
	onProjectPickerOpenChange?: (open: boolean) => void;
}) {
	const harnessReady = selectedHarnessIsConnected(
		session.connection,
		harnessId,
	);
	const canResumeFollowUp = canResumeDisconnectedFollowUp({
		harnessId,
		connection: session.connection,
		turnStatus: session.turnStatus,
		snapshotAvailable: session.snapshotAvailable,
	});
	const composerReady = (harnessReady && session.canSend) || canResumeFollowUp;
	const listedCatalog =
		session.models.length > 0
			? session.models
			: session.listedModelId
				? [
						{
							id: session.listedModelId,
							label:
								listedModelDisplayName(session.listedModelId) ||
								session.listedModelId,
						},
					]
				: [];
	const loadCatalog = useServerFn(getAgentModelCatalog);
	const identity = authClient.useSession();
	const queryClient = useQueryClient();
	useEffect(() => {
		if (
			!identity.data?.user.id ||
			connectedProviderId(session.connection) !== harnessId ||
			session.models.length === 0
		)
			return;
		queryClient.setQueryData(
			["agent-model-catalog", identity.data.user.id, harnessId],
			session.models,
		);
	}, [
		identity.data?.user.id,
		harnessId,
		session.connection,
		session.models,
		queryClient,
	]);
	const catalog = useQuery({
		queryKey: ["agent-model-catalog", identity.data?.user.id, harnessId],
		enabled: Boolean(identity.data?.user.id),
		queryFn: () => loadCatalog({ data: { provider: harnessId } }),
		staleTime: 60_000,
		placeholderData:
			loadedCatalog?.harnessId === harnessId ? loadedCatalog.models : undefined,
	});
	// Y² has no machine for the Claude CLI: the Claude models are offered to
	// it only when the user has a Claude runner box (one flag on the Claude
	// subscription view the picker already reads, not a request of its own).
	const loadClaudeView = useServerFn(getClaudeSubscription);
	const claudeView = useQuery({
		queryKey: ["claude-subscription"],
		queryFn: () => loadClaudeView(),
		staleTime: 30_000,
		enabled: branchless,
	});
	const withoutClaudeCode =
		branchless && !(claudeView.data?.enabled && claudeView.data.ySquaredRunner);
	const models = useMemo(() => {
		const listed = sessionModelsFromListed(
			composerListedModels({
				sessionModels: session.models,
				catalogModels: catalog.data ?? [],
				rememberedModels: listedCatalog,
				sessionConnected: connectedProviderId(session.connection) === harnessId,
				harnessId,
			}),
		);
		// Y² has no machine for the Claude CLI: no Claude subscription models.
		return withoutClaudeCode ? withoutClaudeCodeModels(listed) : listed;
	}, [
		withoutClaudeCode,
		session.models,
		session.connection,
		harnessId,
		listedCatalog,
		catalog.data,
	]);
	const [attachments, setAttachments] = useState<File[]>([]);
	/** The branch picked for a new chat, for the project it was picked in. */
	const [basePick, setBasePick] = useState<{
		projectId: string;
		branch: string;
	} | null>(null);
	const baseBranch =
		basePick && basePick.projectId === selectedProject?.id
			? basePick.branch
			: null;
	/**
	 * The last send that came back unsent. Sending the same message again reuses
	 * its id, so a send the server did accept is not queued twice.
	 */
	const unsentSend = useRef<{
		readonly id: string;
		readonly text: string;
		readonly files: readonly File[];
	} | null>(null);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	function attachFiles(selected: readonly File[]) {
		const additions = selected.filter(
			(file) =>
				!attachments.some(
					(existing) =>
						existing.name === file.name &&
						existing.size === file.size &&
						existing.lastModified === file.lastModified,
				),
		);
		const next = [...attachments, ...additions];
		setAttachments(next);
		setAttachmentError(attachmentLimitError(next));
	}
	const readPastedText = useServerFn(readPastedTextFn);
	const pastedTextSession = session.agentSessionId;
	const loadPastedText = pastedTextSession
		? (attachmentId: string) =>
				readPastedText({
					data: { sessionId: pastedTextSession, attachmentId },
				})
		: undefined;
	// A message with only attachments still needs words for the transcript and model.
	const sendableDraft = (text: string) =>
		text || (attachments.length ? ATTACHMENTS_ONLY_TEXT : "");
	const loadRecovery = useServerFn(getConversationRecoveryPoints);
	const recoverPoint = useServerFn(restoreConversationPoint);
	// Known on the server too, so the transcript keeps a recovery row under
	// each user message from the first paint while the points load.
	const recoverable =
		!!selectedProject?.id &&
		!!session.agentSessionId &&
		(harnessId === "codex" || harnessId === "api");
	const recoveryPoints = useQuery({
		queryKey: chatSideKeys.recoveryPoints(
			selectedProject?.id,
			session.agentSessionId,
			session.items.length,
			session.turnStatus,
		),
		enabled: recoverable,
		// The key holds the chat's length and turn status; going back to a
		// chat within the window shows its points without reading them again.
		staleTime: 30_000,
		queryFn: () => {
			if (!selectedProject || !session.agentSessionId) return [];
			return loadRecovery({
				data: {
					projectId: selectedProject.id,
					sessionId: session.agentSessionId,
				},
			});
		},
	});
	const loadForkStatus = useServerFn(getConversationForkStatus);
	const retryFork = useServerFn(retryConversationForkFn);
	const [forkRetrying, setForkRetrying] = useState(false);
	// A forked chat opens before its VM copy is ready: a message sent meanwhile
	// waits queued. Only a chat without a VM can be one.
	const hubDelivery = useHubDelivery();
	const forkStatus = useQuery({
		queryKey: [
			"conversation-fork",
			selectedProject?.id,
			session.agentSessionId,
		],
		enabled:
			!!selectedProject?.id && !!session.agentSessionId && !session.workspaceId,
		queryFn: () =>
			selectedProject && session.agentSessionId
				? loadForkStatus({
						data: {
							projectId: selectedProject.id,
							sessionId: session.agentSessionId,
						},
					})
				: null,
		// While the user's hub pushes, the copy's end is signalled instead.
		refetchInterval: (query) =>
			query.state.data?.state === "preparing"
				? pollUnlessPushed(hubDelivery, 2_000)
				: false,
	});
	useHubRead(
		[hubTopic.fork(session.agentSessionId ?? "")],
		() => void forkStatus.refetch({ cancelRefetch: false }),
		{
			enabled:
				!!selectedProject?.id &&
				!!session.agentSessionId &&
				!session.workspaceId,
		},
	);
	const forkPreparing = forkStatus.data?.state === "preparing";
	const wasForkPreparing = useRef(false);
	useEffect(() => {
		// The copy is bound: Files and Changes now have a workspace to show.
		if (wasForkPreparing.current && !forkStatus.data)
			void refreshRecoveredWorkspace(queryClient);
		wasForkPreparing.current = forkPreparing;
	}, [forkPreparing, forkStatus.data, queryClient]);
	async function retryForkCopy() {
		if (!selectedProject || !session.agentSessionId) return;
		const key = [
			"conversation-fork",
			selectedProject.id,
			session.agentSessionId,
		];
		setForkRetrying(true);
		try {
			queryClient.setQueryData(
				key,
				await retryFork({
					data: {
						projectId: selectedProject.id,
						sessionId: session.agentSessionId,
					},
				}),
			);
		} catch (cause) {
			queryClient.setQueryData(key, {
				state: "failed",
				message:
					cause instanceof Error
						? cause.message
						: "Couldn't fork this chat. Try again.",
			});
		} finally {
			setForkRetrying(false);
		}
	}
	// Text typed before the page's scripts ran, or this browser's saved draft
	// that the first-paint script filled in, stays in the composer. It
	// hydrates as the server rendered it (no draft) and takes the text up
	// before the next paint, so what the draft drives (the send button)
	// updates too: hydration leaves server attributes as they are. A composer
	// mounted later reads its saved draft itself.
	const side = variant === "side";
	const inputId = side ? SIDE_COMPOSER_INPUT_ID : COMPOSER_INPUT_ID;
	const draftKey = side
		? `side:${session.agentSessionId ?? "new"}`
		: composerDraftKey(session.agentSessionId);
	const hydrating = useHydrating();
	const hydrated = useHydrated();
	const stopShortcutHint = useShortcutHint("stop");
	const typedBeforeHydration = useTypedBeforeHydration(inputId);
	const [draft, setDraft] = useState(
		() => initialDraft || (hydrating ? "" : loadComposerDraft(draftKey)),
	);
	useLayoutEffect(() => {
		if (typedBeforeHydration)
			setDraft((current) => current || typedBeforeHydration);
	}, [typedBeforeHydration]);
	const prefillAt = prefill?.at;
	/** When the request in `autoSend` came: state, so its readiness renders. */
	const [autoSendAt, setAutoSendAt] = useState<number | null>(null);
	/** A prefill to send by itself as soon as the new chat can take it. */
	const autoSend = useRef<{
		readonly text: string;
		readonly messageId?: string;
	} | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new request (its time), not each render.
	useEffect(() => {
		if (!prefill) return;
		if (prefill.send) {
			autoSend.current = {
				text: prefill.text,
				...(prefill.messageId ? { messageId: prefill.messageId } : {}),
			};
			setAutoSendAt(prefill.at);
			return;
		}
		const { text, append } = prefill;
		setDraft((current) => draftWithPrefill(current, text, append === true));
		requestAnimationFrame(() => textareaRef.current?.focus());
	}, [prefillAt]);
	// Saved as it is typed, under the chat it was typed in; cleared at once
	// when it empties (a send). Moving to another chat or unmounting saves
	// the pending text right away, still under its own chat.
	const draftSaver = useRef<DraftSaver | null>(null);
	draftSaver.current ??= createDraftSaver(
		saveComposerDraft,
		DRAFT_SAVE_DELAY_MS,
	);
	const savedDraft = useRef(draft);
	const draftKeyNow = useRef(draftKey);
	draftKeyNow.current = draftKey;
	useEffect(() => {
		if (draft === savedDraft.current) return;
		savedDraft.current = draft;
		draftSaver.current?.typed(draftKeyNow.current, draft);
	}, [draft]);
	useEffect(() => {
		void draftKey;
		return () => draftSaver.current?.flush();
	}, [draftKey]);
	// A reload (onto a new deploy, new-build-reload.ts) or leaving the page
	// keeps text typed in the last moment before it.
	useEffect(() => {
		const flush = () => draftSaver.current?.flush();
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, []);
	/** A send: this chat's saved draft goes now, before the chat can change. */
	const clearSavedDraft = () => {
		savedDraft.current = "";
		draftSaver.current?.typed(draftKey, "");
	};
	const drafting = draft.trim().length > 0;
	const draftStarted = useRef(onDraftStarted);
	draftStarted.current = onDraftStarted;
	useEffect(() => {
		if (drafting) draftStarted.current?.();
	}, [drafting]);
	const loadProjectCommands = useServerFn(listProjectCommandsFn);
	const saveProjectSecret = useServerFn(saveProjectSecretFn);
	const pushApprovalStatus = useServerFn(pushApprovalStatusFn);
	const pushApprovedChange = useServerFn(pushApprovedChangeFn);
	const cancelPushApproval = useServerFn(cancelPushApprovalFn);
	const projectCommands = useQuery({
		queryKey: ["project-commands", selectedProject?.id, session.agentSessionId],
		// Only when the user starts a slash command; never wakes a paused VM.
		enabled: !!selectedProject?.id && draft.startsWith("/"),
		staleTime: 60_000,
		queryFn: () =>
			selectedProject
				? loadProjectCommands({
						data: {
							projectId: selectedProject.id,
							sessionId: session.agentSessionId ?? undefined,
						},
					})
				: [],
	});
	const [modelId, setModelId] = useState(session.listedModelId);
	const [reasoningId, setReasoningId] = useState("");
	const [speed, setSpeed] = useState<ComposerSpeed>("");
	const [alternateContext, setAlternateContext] = useState(false);
	const [lastModelByHarness, setLastModelByHarness] = useState<
		Partial<Record<AgentProviderId, string>>
	>(() =>
		session.listedModelId ? { [harnessId]: session.listedModelId } : {},
	);
	const selectedModel = models.find((model) => model.id === modelId);
	const [optimisticItems, setOptimisticItems] = useState<SessionItem[]>([]);
	const [slashIndex, setSlashIndex] = useState(0);
	/** The user moved through the menu, so Enter takes the highlighted entry. */
	const [slashPicked, setSlashPicked] = useState(false);
	const [slashMenuDismissed, setSlashMenuDismissed] = useState<string | null>(
		null,
	);
	// Kept while the person types, so the transcript does not render again.
	const items = useMemo(
		() => visibleSessionItems(session.items, optimisticItems),
		[session.items, optimisticItems],
	);
	useMarkPlanLimitFromSwitches(items);
	// The message held for setup shows in the setup block (with its own
	// Edit and Remove), not again as a queued message.
	const heldMessageId = setupHold?.messageId;
	const timelineItems = useMemo(
		() =>
			heldMessageId
				? items.filter(
						(item) => !(item.id === heldMessageId && isQueuedUserMessage(item)),
					)
				: items,
		[items, heldMessageId],
	);
	const turnStatus = session.turnStatus;
	// Goal mode (the model started it): the composer says so while it runs.
	const goal = activeGoal(items, turnStatus);
	// The turn answered and only commits its changes: Send (which waits for
	// the commit) instead of Stop.
	const stoppable =
		turnStatus === "running" && !turnSavingChanges(items, turnStatus);
	// No reload onto a new deploy mid-send or while this chat's turn streams.
	useHoldNewBuildReload("send", busy);
	useHoldNewBuildReload("turn", turnStatus === "running");
	/** The agents list: the lead, then this request's helpers; one is open in the chat view. */
	const agents = agentPanelRows({
		tasks: childTasks,
		leadItems: items,
		leadTurnStatus: turnStatus,
		leadHarness: harnessId,
		leadModelId: session.listedModelId,
		background: backgroundRuns,
	});
	const identities = useMemo(() => helperIdentities(childTasks), [childTasks]);
	const [selectedAgentId, setSelectedAgentId] = useState(LEAD_ROW_ID);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	/** The composer's caret, for the "@" popover. */
	const [caret, setCaret] = useState(0);
	const [mentionIndex, setMentionIndex] = useState(0);
	const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
	const selectedHelper = agents.helpers.find(
		(row) => row.id === selectedAgentId,
	);
	const selectedTask = selectedHelper
		? childTasks.find((task) => task.id === selectedHelper.id)
		: undefined;
	// The agent whose composer this is never appears: it is the one written to.
	const mentionSelf = selectedHelper?.id ?? MAIN_MENTION_ID;
	const mentionList = useMemo(
		() => mentionAgents(identities, mentionSelf),
		[identities, mentionSelf],
	);
	const sendToHelper = useServerFn(sendHelperMessage);
	/** Messages the user sent a helper that its list does not show yet. */
	const [helperOutbox, setHelperOutbox] = useState<
		readonly {
			readonly id: string;
			readonly helperId: string;
			readonly text: string;
			readonly sentAt: number;
		}[]
	>([]);
	const [helperError, setHelperError] = useState<string | null>(null);
	const [noProject, setNoProject] = useState<string | null>(null);
	/** The block a send attempt ran into; shown while that block still holds. */
	const [triedBlock, setTriedBlock] = useState<
		ComposerSendBlock["kind"] | null
	>(null);
	useEffect(() => {
		setHelperOutbox((current) => {
			const next = current.filter((sent) => {
				const task = childTasks.find((entry) => entry.id === sent.helperId);
				if (!task || Date.now() - sent.sentAt > 30_000) return false;
				const listed =
					task.queuedSteering?.some(
						(message) => message.from === "user" && message.text === sent.text,
					) ||
					task.items.some(
						(item) =>
							item.kind === "userMessage" &&
							parseSteering(item.text)?.text === sent.text,
					);
				return !listed;
			});
			return next.length === current.length ? current : next;
		});
	}, [childTasks]);
	function openAgent(id: string) {
		setHelperError(null);
		setSelectedAgentId((current) =>
			current === id && id !== LEAD_ROW_ID ? LEAD_ROW_ID : id,
		);
	}
	function sendDraftToHelper() {
		const text = draft.trim();
		if (!selectedHelper || !text || !selectedProject || !session.agentSessionId)
			return;
		if (!selectedHelper.messageable) {
			setHelperError(`${selectedHelper.name} has finished.`);
			return;
		}
		const id = crypto.randomUUID();
		const helperId = selectedHelper.id;
		setHelperError(null);
		setDraft("");
		setHelperOutbox((current) => [
			...current,
			{ id, helperId, text, sentAt: Date.now() },
		]);
		sendToHelper({
			data: {
				projectId: selectedProject.id,
				rootSessionId: session.agentSessionId,
				helperId,
				requestId: id,
				message: text,
			},
		}).then(
			() => queryClient.invalidateQueries({ queryKey: ["agent-tasks"] }),
			(cause: unknown) => {
				setHelperOutbox((current) => current.filter((sent) => sent.id !== id));
				setDraft((current) => (current.trim() ? current : text));
				setHelperError(
					cause instanceof Error
						? cause.message
						: "Could not send the message.",
				);
			},
		);
	}
	const parentName = (parentId: string) =>
		parentId === session.agentSessionId
			? MAIN_NAME
			: (identities.get(parentId)?.name ?? MAIN_NAME);
	// The same function while typing, so the transcript's rows are not drawn again.
	const afterRecovery = useStableCallback(onRecovered);
	const sessionId = session.agentSessionId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when what the controls show changes.
	const recoveryControls = useMemo(
		() =>
			afterRecovery && recoverable && selectedProject && sessionId
				? (messageId: string) => {
						const point = recoveryPoints.data?.find(
							(point) => point.messageId === messageId,
						);
						// The row's room stays while the points load or when a
						// message has none: the transcript's spacing never moves.
						if (!point) return <ConversationRecoverySlot />;
						return (
							<ConversationRecovery
								codeAvailable={point.codeAvailable}
								forkAvailable={point.forkAvailable}
								busy={busy || session.turnStatus === "running"}
								onRecover={async (mode) => {
									const recovered = await recoverPoint({
										data: {
											projectId: selectedProject.id,
											sessionId,
											messageId,
											mode,
										},
									});
									// The server is done: the prompt and the restored
									// code show now, not after the chat reloads.
									if (recovered.prompt) setDraft(recovered.prompt);
									if (mode === "code" || mode === "both")
										void refreshRecoveredWorkspace(queryClient);
									await afterRecovery(
										recovered.id,
										recovered.prompt,
										recovered.items,
									);
									await recoveryPoints.refetch();
								}}
							/>
						);
					}
				: undefined,
		[
			afterRecovery,
			recoverable,
			selectedProject,
			sessionId,
			recoveryPoints.data,
			busy,
			session.turnStatus,
		],
	);
	const helperLines = { identities, onSelect: openAgent };
	const lastUserText = lastUserMessageText(items);
	const followUpLayout =
		side ||
		Boolean(setupHold) ||
		sessionUsesFollowUpLayout({
			items,
			turnStatus,
			listedTitle,
		});
	// The runtime's live model list; null while it is unknown.
	const availableModelIds =
		catalog.data && !catalog.isError
			? catalog.data.map((model) => model.id)
			: connectedProviderId(session.connection) === harnessId
				? session.models.map((model) => model.id)
				: null;
	const sendBlock = composerSendBlock({
		harnessId,
		blockers: session.sendBlockers,
		modelId,
		availableModelIds,
	});
	const shownSendBlock =
		sendBlock && sendBlock.kind === triedBlock ? sendBlock : null;
	function openSendBlockFix(block: ComposerSendBlock) {
		if (block.action === "model_picker")
			document.getElementById(MODEL_PICKER_ID)?.click();
		else onOpenSettings?.(block.action);
	}
	function composerCanSend(text: string, slashCommand: boolean) {
		if (sendBlock) return false;
		return composerSendIsEnabled({
			harnessId,
			connection: session.connection,
			turnStatus,
			snapshotAvailable: session.snapshotAvailable,
			canSend: session.canSend,
			busy,
			draft: text,
			modelId,
			slashDraft: slashCommand,
		});
	}
	const slashDraft = parseSlashDraft(draft);
	const claudeRoute = isClaudeCodeRoute(modelId);
	const slashCommands = useMemo(
		() =>
			composerSlashCommands({
				authenticated: harnessReady,
				requiresAccountLogin: harnessRequiresAccountLogin(harnessId),
				turnRunning: turnStatus === "running",
				canSend: composerReady,
				hasLastUserMessage: Boolean(lastUserText),
				hasModels: models.length > 0,
				canCompact: composerReady && Boolean(lastUserText) && !claudeRoute,
				compactUnavailableReason: claudeRoute
					? "Claude Agent manages its own context"
					: undefined,
			}),
		[
			composerReady,
			harnessId,
			lastUserText,
			claudeRoute,
			models.length,
			harnessReady,
			turnStatus,
		],
	);
	// The side chat sits in the right sidebar, whose tabs these commands open.
	const allSlashCommands = side
		? []
		: [
				...slashCommands,
				...(projectCommands.data ?? []).map((command) => ({
					...command,
					availability: composerReady
						? command.availability
						: ("unavailable" as const),
					unavailableReason: "Wait for the current run to finish",
				})),
			];
	// Only an exact command runs; any other slash text is an ordinary message.
	const draftCommand = slashDraft
		? exactSlashCommand(slashDraft, allSlashCommands)
		: null;
	const visibleSlashCommands =
		slashDraft && slashMenuDismissed !== draft
			? slashMenuCommands(slashDraft, allSlashCommands)
			: [];

	// "@": the chat's other agents, filtered by what follows it.
	const mention =
		mentionDismissed !== draft ? activeMention(draft, caret) : null;
	const visibleMentions = mention
		? mentionMatches(mentionList, mention.query)
		: [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: Every edit of the draft resets the menu highlight.
	useEffect(() => {
		setSlashIndex(0);
		setSlashPicked(false);
		setMentionIndex(0);
	}, [draft]);

	function pickMention(agent: MentionAgent) {
		if (!mention) return;
		const next = insertMention(draft, mention, caret, agent.name);
		setDraft(next.text);
		setCaret(next.caret);
		requestAnimationFrame(() => {
			const input = textareaRef.current;
			input?.focus();
			input?.setSelectionRange(next.caret, next.caret);
		});
	}

	function handleMentionKey(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (visibleMentions.length === 0) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setMentionIndex(
				(index) =>
					(index + step + visibleMentions.length) % visibleMentions.length,
			);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setMentionDismissed(draft);
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			const agent = visibleMentions[mentionIndex];
			if (!agent || event.nativeEvent.isComposing) return false;
			event.preventDefault();
			pickMention(agent);
			return true;
		}
		return false;
	}

	// A model picked from another harness's section switches the harness
	// first; until that harness's own catalog arrives, the list above is a
	// stand-in that may not hold the pick, so the pick is kept, not replaced.
	const catalogSettled =
		connectedProviderId(session.connection) === harnessId ||
		(catalog.isFetched && !catalog.isPlaceholderData);
	useEffect(() => {
		const connectedHarness = connectedProviderId(session.connection);
		const lastUsedForCatalog =
			lastModelByHarness[harnessId] ||
			(connectedHarness === harnessId ? session.listedModelId : "");
		setModelId((current) => {
			if (current && !catalogSettled) return current;
			const next = composerModelIdForCatalog({
				requestedId: current,
				catalog: models,
				lastUsedForCatalog,
				excludedIds: session.blockedListedModelIds,
			});
			return next === current ? current : next;
		});
	}, [
		catalogSettled,
		harnessId,
		lastModelByHarness,
		session.blockedListedModelIds,
		session.connection,
		session.listedModelId,
		models,
	]);

	useEffect(() => {
		if (!modelId || !models.some((model) => model.id === modelId)) return;
		setLastModelByHarness((current) =>
			current[harnessId] === modelId
				? current
				: { ...current, [harnessId]: modelId },
		);
	}, [harnessId, modelId, models]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Model changes must reset overrides even when their default reasoning levels match.
	useEffect(() => {
		setReasoningId(selectedModel?.reasoning?.defaultLevelId ?? "");
		setSpeed("");
		setAlternateContext(false);
	}, [selectedModel?.id, selectedModel?.reasoning?.defaultLevelId]);

	useEffect(() => {
		setOptimisticItems((current) =>
			current.filter(
				(item) =>
					item.kind !== "userMessage" ||
					!session.items.some(
						(existing) =>
							existing.kind === "userMessage" && existing.id === item.id,
					),
			),
		);
	}, [session.items]);

	// Project setup: its request goes as soon as the new chat
	// can take it. A send block (no model connected, say) shows its fix after
	// a moment instead of the request waiting silently.
	const autoSendReady =
		autoSendAt !== null &&
		autoSend.current !== null &&
		// The new chat exists: a send before that is refused as "still opening".
		Boolean(session.agentSessionId) &&
		composerCanSend(autoSend.current.text, false);
	const autoSendWaiting =
		autoSendAt !== null &&
		autoSend.current !== null &&
		Boolean(session.agentSessionId) &&
		Boolean(sendBlock);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires on readiness, sending the text it holds.
	useEffect(() => {
		const request = autoSend.current;
		if (request === null || !autoSendReady) return;
		autoSend.current = null;
		setAutoSendAt(null);
		onPrefillSent?.();
		sendText(request.text, undefined, request.messageId);
	}, [autoSendReady]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a block that outlasts loading is shown once.
	useEffect(() => {
		if (!autoSendWaiting) return;
		const timer = setTimeout(() => {
			const request = autoSend.current;
			if (request === null) return;
			autoSend.current = null;
			setAutoSendAt(null);
			onPrefillSent?.();
			sendText(request.text, undefined, request.messageId);
		}, 4000);
		return () => clearTimeout(timer);
	}, [autoSendWaiting]);

	function sendText(typed: string, continueOn?: string, messageId?: string) {
		const text = sendableDraft(typed);
		const projectNotice = text
			? composerProjectNotice({ selectedProjectId: selectedProject?.id })
			: null;
		setNoProject(projectNotice);
		// The text stays in the box; nothing is sent until there is a project.
		if (projectNotice) return;
		// Nor while something stops it: say what, with its fix.
		const blocked = blockedSendAttempt(text, sendBlock);
		if (blocked) {
			setTriedBlock(blocked.kind);
			return;
		}
		if (!composerCanSend(text, false) || attachmentError) return;
		const files = attachments;
		captureAnalytics("prompt_submitted", {
			runtime: harnessId,
			attempts: 1,
		});
		const retry = unsentSend.current;
		const userMessageId =
			messageId ??
			(retry && sameSend(retry, text, files) ? retry.id : crypto.randomUUID());
		startInteraction("first_token", userMessageId);
		unsentSend.current = null;
		setOptimisticItems((current) => [
			...current,
			{
				kind: "userMessage",
				id: SessionItemId(userMessageId),
				text,
				// Sent during a run, it waits for the turn to end.
				...(turnStatus === "running" ? { queued: true as const } : {}),
				...(files.length
					? {
							attachments: files.map((file) => {
								const id = crypto.randomUUID();
								return {
									id,
									name: safeAttachmentName(file.name),
									mediaType: file.type || "application/octet-stream",
									size: file.size,
									...sentFileFields(id, file),
								};
							}),
						}
					: {}),
			},
		]);
		// Nothing was sent: take the message back and return what the user typed.
		const unsend = (restore: boolean) => {
			setOptimisticItems((current) =>
				current.filter((item) => item.id !== SessionItemId(userMessageId)),
			);
			if (!restore) return;
			unsentSend.current = { id: userMessageId, text, files };
			setDraft((current) => (current.trim() ? current : typed));
			if (files.length)
				setAttachments((current) => (current.length ? current : files));
		};
		const reasoning = resolveReasoningLevel(selectedModel, reasoningId);
		// Only a new chat's first message carries a base; the server ignores it later.
		const startBranch = followUpLayout ? null : baseBranch;
		const send = (encoded: readonly IncomingAttachment[]) =>
			onSend(text, modelId, {
				...(reasoning?.id ? { reasoningId: reasoning.id } : {}),
				...(speed ? { speed } : {}),
				alternateContext:
					alternateContext && Boolean(selectedModel?.contextWindow),
				...(continueOn ? { continueOn } : {}),
				userMessageId,
				...(encoded.length ? { attachments: encoded } : {}),
				...(startBranch ? { baseBranch: startBranch } : {}),
			})?.then((result) => {
				if (result !== "sent") unsend(result === "unsent");
			});
		clearSavedDraft();
		setDraft("");
		if (!files.length) {
			send([]);
			return;
		}
		setAttachments([]);
		encodeAttachments(files).then(send, (cause: unknown) => {
			setOptimisticItems((current) =>
				current.filter((item) => item.id !== SessionItemId(userMessageId)),
			);
			setDraft(typed);
			setAttachments(files);
			setAttachmentError(
				cause instanceof Error ? cause.message : "Could not attach files.",
			);
		});
	}

	function sendDraft() {
		const command = slashPicked
			? (visibleSlashCommands[slashIndex] ?? draftCommand)
			: draftCommand;
		if (command) {
			runSlashCommand(command);
			return;
		}
		sendText(draft.trim());
	}

	function runSlashCommand(command: SlashCommand) {
		if (command.availability !== "ready") return;
		if (slashCommandOpensSideChat(command)) {
			onOpenInspector("side");
			setDraft("");
			return;
		}
		if (command.id === "custom" && command.template) {
			setDraft("");
			sendText(
				expandProjectCommand(command.template, slashDraft?.argument ?? ""),
			);
			return;
		}
		if (command.id === "compact") {
			setDraft("");
			sendText(COMPACT_COMMAND_TEXT);
			return;
		}
		if (command.id === "retry" && lastUserText) {
			setDraft("");
			sendText(lastUserText);
			return;
		}
		if (command.id === "model") {
			setDraft("");
			document.getElementById(MODEL_PICKER_ID)?.click();
			return;
		}
		if (
			command.id === "files" ||
			command.id === "diff" ||
			command.id === "terminal" ||
			command.id === "desktop"
		) {
			onOpenInspector(command.id);
			setDraft("");
		}
	}

	/** Esc in an empty composer stops the running turn, as in Codex and Claude Code. */
	function handleStopKey(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (!stoppable || attachments.length) return false;
		if (
			!shortcutMatches(
				"stopFromComposer",
				event.nativeEvent,
				keyFocusOf(event.currentTarget),
				currentShortcutPlatform(),
			)
		)
			return false;
		event.preventDefault();
		onStop();
		return true;
	}

	function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (!slashDraft || visibleSlashCommands.length === 0) return false;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setSlashPicked(true);
			setSlashIndex((index) => (index + 1) % visibleSlashCommands.length);
			return true;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setSlashPicked(true);
			setSlashIndex(
				(index) =>
					(index - 1 + visibleSlashCommands.length) %
					visibleSlashCommands.length,
			);
			return true;
		}
		if (event.key === "Escape") {
			// Close the menu; never erase what the user typed.
			event.preventDefault();
			setSlashMenuDismissed(draft);
			return true;
		}
		// Tab completes from the menu; Enter takes it only once the user moved
		// through it, otherwise the draft runs as an exact command or is sent.
		if (event.key === "Tab" || (event.key === "Enter" && slashPicked)) {
			const command = visibleSlashCommands[slashIndex];
			if (!command) return false;
			event.preventDefault();
			runSlashCommand(command);
			return true;
		}
		return false;
	}

	return (
		<section
			className="session-launcher"
			aria-labelledby="session-title"
			data-layout={followUpLayout ? "chat" : "empty"}
		>
			<h1 id="session-title" className="sr-only">
				Session
			</h1>
			{selectedHelper && selectedTask ? (
				<>
					<div className="helper-view-header">
						<AgentIcon
							icon={selectedHelper.icon}
							color={selectedHelper.color}
						/>
						<span className="helper-view-name">{selectedHelper.name}</span>
						{selectedHelper.task ? (
							<span className="helper-view-task" title={selectedHelper.title}>
								{selectedHelper.task}
							</span>
						) : null}
						<button
							type="button"
							className="helper-view-back"
							onClick={() => openAgent(LEAD_ROW_ID)}
						>
							Back to Main
						</button>
					</div>
					<SessionTimeline
						key={selectedTask.id}
						items={selectedTask.items}
						olderItems={
							olderHelperItems && helperHasOlderItems(selectedTask)
								? {
										loading: olderHelperItems.loadingId === selectedTask.id,
										onLoad: () => olderHelperItems.onLoad(selectedTask.id),
									}
								: undefined
						}
						turnStatus={selectedTask.turnStatus}
						tasks={childTasks}
						taskParentId={selectedTask.id}
						helperLines={helperLines}
						senderName={parentName(selectedTask.parentSessionId)}
						queuedSteering={[
							...(selectedTask.queuedSteering ?? []).map((message) => ({
								id: message.id,
								from:
									message.from === "user"
										? "You"
										: parentName(selectedTask.parentSessionId),
								text: message.text,
							})),
							...helperOutbox
								.filter(
									(sent) =>
										sent.helperId === selectedTask.id &&
										!selectedTask.queuedSteering?.some(
											(message) =>
												message.from === "user" && message.text === sent.text,
										),
								)
								.map((sent) => ({ id: sent.id, from: "You", text: sent.text })),
						]}
						fill={followUpLayout}
						onOpenFile={onOpenFile}
					/>
				</>
			) : emptyState &&
				!setupHold &&
				timelineItems.length === 0 &&
				turnStatus !== "running" ? (
				<div className="session-empty-state">
					{emptyState((text) => sendText(text))}
				</div>
			) : (
				<SessionTimeline
					// Another chat opens as a new list, at its end.
					key={session.agentSessionId ?? "new"}
					setupProjectId={selectedProject?.id}
					recoveryControls={recoveryControls}
					tasks={childTasks}
					helperLines={helperLines}
					memoryActions={memoryActions}
					items={timelineItems}
					turnStatus={turnStatus}
					fill={followUpLayout}
					onOpenFile={onOpenFile}
					onOpenCanvas={onOpenCanvas}
					secretActions={
						selectedProject
							? {
									disabled: busy || turnStatus === "running",
									onSave: async ({ name, value, kind }) => {
										await saveProjectSecret({
											data: {
												projectId: selectedProject.id,
												name,
												value,
												kind,
											},
										});
									},
									onAnswer: (saved, skipped) =>
										sendText(secretsAnsweredText(saved, skipped)),
								}
							: undefined
					}
					pushActions={
						session.agentSessionId
							? {
									// Neither answer starts a turn, so a running turn does not block it.
									disabled: false,
									status: (itemId) =>
										pushApprovalStatus({
											data: { sessionId: session.agentSessionId ?? "", itemId },
										}),
									push: (itemId) =>
										pushApprovedChange({
											data: { sessionId: session.agentSessionId ?? "", itemId },
										}),
									cancel: (itemId) =>
										cancelPushApproval({
											data: { sessionId: session.agentSessionId ?? "", itemId },
										}),
								}
							: undefined
					}
					questionActions={{
						disabled: busy || turnStatus === "running",
						onAnswer: (text) => sendText(text),
					}}
					failoverActions={{
						disabled: busy || turnStatus === "running",
						onContinue: (key) => sendText(FAILOVER_CONTINUE_TEXT, key),
					}}
					trailing={
						setupHold
							? setupHold.render(
									!timelineItems.some(
										(item) => item.id === setupHold.messageId,
									),
								)
							: undefined
					}
					stopping={stopping}
					onRemoveQueued={onRemoveQueued}
					onEditQueued={onEditQueued}
					onSendQueued={onSendQueued}
					readPastedText={loadPastedText}
					olderItems={olderItems}
				/>
			)}
			<div className="session-dock">
				{!side &&
				visibleSlashCommands.length === 0 &&
				visibleMentions.length === 0 ? (
					<ProjectContext
						projects={projects}
						selectedProject={selectedProject}
						onSelectProject={onSelectProject}
						projectLocked={followUpLayout}
						onSetUpEnvironment={onSetUpEnvironment}
						repairModel={
							selectedModel && (harnessId === "api" || harnessId === "codex")
								? {
										harness: harnessId,
										modelId: selectedModel.id,
										allowApi: false,
									}
								: undefined
						}
						repairModelLabel={selectedModel?.label}
						projectPickerOpen={projectPickerOpen}
						onProjectPickerOpenChange={onProjectPickerOpenChange}
						baseBranch={baseBranch}
						onBaseBranchChange={(branch) => {
							if (selectedProject)
								setBasePick({ projectId: selectedProject.id, branch });
						}}
						currentBranch={session.selectedBranch}
						branchless={branchless}
					/>
				) : null}
				<div className="composer-shell">
					<ComposerSignIn
						harnessReady={harnessReady}
						harnessId={harnessId}
						connection={session.connection}
						busy={busy}
						onConnect={onConnect}
					/>
					{goal ? (
						<div
							className="composer-goal"
							role="status"
							data-kind="goal-mode"
							title={goal.objective}
						>
							<Target size={13} aria-hidden="true" />
							<span className="composer-goal-label">Goal mode</span>
							<span className="composer-goal-objective">{goal.objective}</span>
							{goal.continuations > 0 ? (
								<span className="composer-goal-count">
									round {goal.continuations + 1}
								</span>
							) : null}
						</div>
					) : null}
					{withoutClaudeCode &&
					[modelId, session.listedModelId, lastModelByHarness.api].some(
						(id) => id && isClaudeCodeRoute(id),
					) ? (
						<p className="session-attachment-error" role="status">
							{Y_SQUARED_CLAUDE_CODE_NOTE}
						</p>
					) : null}
					<div className="session-composer">
						{visibleMentions.length > 0 ? (
							<MentionPopover
								agents={visibleMentions}
								activeIndex={mentionIndex}
								onHover={setMentionIndex}
								onSelect={pickMention}
							/>
						) : visibleSlashCommands.length > 0 ? (
							<SlashCommandPalette
								commands={visibleSlashCommands}
								activeIndex={slashIndex}
								onHover={setSlashIndex}
								onSelect={runSlashCommand}
							/>
						) : null}

						{attachments.length > 0 && (
							<ul className="attachment-tiles" aria-label="Attached files">
								{attachments.map((file, index) => {
									const key = `${file.name}-${file.lastModified}-${file.size}`;
									const remove = () => {
										const next = attachments.filter(
											(_, fileIndex) => fileIndex !== index,
										);
										setAttachments(next);
										setAttachmentError(attachmentLimitError(next));
										textareaRef.current?.focus();
									};
									const pasted = pastedFileText(file);
									return pasted !== undefined &&
										isPastedText({ name: file.name, mediaType: file.type }) ? (
										<PastedTextTile key={key} text={pasted} onRemove={remove} />
									) : (
										<FileTile
											key={key}
											name={file.name}
											mediaType={file.type}
											size={file.size}
											onRemove={remove}
										/>
									);
								})}
							</ul>
						)}
						<TaskInput
							id={inputId}
							draftKey={draftKey}
							textareaRef={textareaRef}
							onCaretChange={setCaret}
							value={draft}
							onChange={(value) => {
								setDraft(value);
								if (helperError) setHelperError(null);
							}}
							onSubmit={selectedHelper ? sendDraftToHelper : sendDraft}
							disabled={busy && !selectedHelper}
							placeholder={
								selectedHelper
									? `Message ${selectedHelper.name}…`
									: side
										? "Ask while Main works…"
										: agents.lead.status === "free"
											? agents.helpers.some((row) => row.status === "working")
												? "Ask Main anything while subagents work"
												: "Ask Main anything while commands run"
											: setupPlaceholder
												? setupPlaceholder
												: continuedChatAwaitsMessage(items)
													? "Continue where you left off…"
													: followUpLayout
														? "Follow up…"
														: "What would you like to work on?"
							}
							onKeyDown={(event) =>
								handleMentionKey(event) ||
								(!selectedHelper && handleComposerKey(event)) ||
								(!selectedHelper && handleStopKey(event))
							}
							onPaste={(event) => {
								// Helpers take text only; a large paste there stays inline.
								if (selectedHelper) return;
								const text = event.clipboardData.getData("text/plain");
								if (!isLargePaste(text)) return;
								event.preventDefault();
								attachFiles([
									pastedTextFile(
										text,
										nextPastedTextNumber(attachments.map((file) => file.name)),
									),
								]);
							}}
						/>
						{forkPreparing ? (
							<p className="model-provider-notice">Preparing workspace</p>
						) : forkStatus.data?.state === "failed" ? (
							<p className="session-attachment-error" role="alert">
								{forkStatus.data.message}{" "}
								<button
									type="button"
									className="session-inline-action"
									disabled={forkRetrying}
									onClick={() => void retryForkCopy()}
								>
									Retry
								</button>
							</p>
						) : null}
						{helperError ? (
							<p className="session-attachment-error" role="alert">
								{helperError}
							</p>
						) : null}
						{noProject && !selectedProject ? (
							<p className="session-attachment-error" role="alert">
								{noProject}{" "}
								<button
									type="button"
									className="session-inline-action"
									onClick={() => onProjectPickerOpenChange?.(true)}
								>
									Choose repository
								</button>
							</p>
						) : null}
						{attachmentError && (
							<p className="session-attachment-error" role="alert">
								{attachmentError}
							</p>
						)}
						{shownSendBlock && !(noProject && !selectedProject) ? (
							<SendBlockNotice
								block={shownSendBlock}
								onFix={
									shownSendBlock.action === "model_picker" || onOpenSettings
										? openSendBlockFix
										: undefined
								}
							/>
						) : null}
						<div className="session-toolbar">
							<SessionControls
								contextIndicator={
									selectedTask ? (
										// A sub-agent has its own context window: show its own.
										selectedTask.contextUsage ? (
											<ContextUsage {...selectedTask.contextUsage} />
										) : null
									) : harnessId === "codex" ||
										recordedContextUsage(session.items) ? (
										<ContextUsage
											selectedCapacity={
												chosenContextWindow(
													selectedModel?.contextWindow ?? undefined,
													alternateContext,
												) ?? selectedModel?.contextCapacity
											}
											modelChanged={modelId !== session.listedModelId}
											context={
												session.usage?.context ??
												recordedContextUsage(session.items)?.context
											}
											compacting={
												session.usage?.compacting ??
												recordedContextUsage(session.items)?.compacting
											}
										/>
									) : null
								}
								providerConnected={
									harnessReady ||
									(harnessId === "codex" && session.snapshotAvailable)
								}
								catalogStatus={
									catalog.isPending
										? "loading"
										: catalog.isError
											? "error"
											: "ready"
								}
								onConnect={
									catalog.isError
										? () => {
												void catalog.refetch();
											}
										: onConnect
								}
								harnessId={harnessId}
								onHarnessIdChange={onHarnessIdChange}
								models={models}
								withoutClaudeCode={withoutClaudeCode}
								modelId={modelId}
								listedModelId={modelId || session.listedModelId}
								onModelIdChange={setModelId}
								reasoningId={reasoningId}
								onReasoningIdChange={setReasoningId}
								speed={speed}
								onSpeedChange={setSpeed}
								alternateContext={alternateContext}
								onAlternateContextChange={setAlternateContext}
								onAttachFiles={attachFiles}
							/>
							{stoppable ? (
								<button
									type="button"
									className="session-send"
									aria-label="Stop"
									title={titleWithShortcut("Stop this run", stopShortcutHint)}
									onClick={onStop}
								>
									<span className="send-face send-face-stop">
										<Square className="size-3.5" fill="currentColor" />
									</span>
								</button>
							) : null}
							{selectedHelper ? (
								<button
									type="button"
									className="session-send"
									aria-label={`Send to ${selectedHelper.name}`}
									disabled={!draft.trim() || !selectedHelper.messageable}
									title={
										selectedHelper.messageable
											? "Send; it reads it at its next step"
											: "It has finished"
									}
									onClick={sendDraftToHelper}
								>
									<span className="send-face">
										<ArrowUp className="size-4" />
									</span>
								</button>
							) : !stoppable || draft.trim() || attachments.length ? (
								<button
									type="button"
									className="session-send"
									aria-label="Send"
									// Before hydration: ready once the composer has text (data-has-text, session-composer.css).
									data-ready-with-text={
										!hydrated && composerCanSend("text", false)
											? "true"
											: undefined
									}
									disabled={
										Boolean(attachmentError) ||
										(draftCommand
											? draftCommand.availability !== "ready"
											: !composerCanSend(sendableDraft(draft.trim()), false))
									}
									title={
										sendBlock
											? sendBlock.message
											: turnStatus === "running"
												? stoppable
													? "Queue in this chat"
													: "Sends once the changes are saved"
												: canResumeFollowUp
													? "Resume and send"
													: harnessReady
														? session.canSend
															? "Send task"
															: "Wait for this harness to finish starting"
														: composerCanStartSignIn({
																	harnessId,
																	connection: session.connection,
																	snapshotAvailable: session.snapshotAvailable,
																	busy,
																	draft,
																	slashDraft: Boolean(draftCommand),
																})
															? "Send"
															: harnessRequiresAccountLogin(harnessId)
																? `Sign in to ${agentProviderById(harnessId).name} to start a session`
																: `Connect ${agentProviderById(harnessId).name} to start a session`
									}
									onClick={sendDraft}
								>
									<span className="send-face">
										<ArrowUp className="size-4" />
									</span>
								</button>
							) : null}
						</div>
						{selectedModel?.notice ? (
							<p className="model-provider-notice">{selectedModel.notice}</p>
						) : null}
					</div>
				</div>
				{side ? null : (
					<AgentPanel
						lead={agents.lead}
						helpers={agents.helpers}
						background={agents.background}
						selectedId={selectedHelper ? selectedHelper.id : LEAD_ROW_ID}
						onSelect={openAgent}
					/>
				)}
			</div>
		</section>
	);
}

function sameSend(
	send: { readonly text: string; readonly files: readonly File[] },
	text: string,
	files: readonly File[],
) {
	return (
		send.text === text &&
		send.files.length === files.length &&
		send.files.every((file, index) => file === files[index])
	);
}

/** The side chat: the same chat view as Main, sending to its own session. */
export function SideChat({
	projectId,
	parent,
	parentTurnStatus,
	harnessId,
	onHarnessIdChange,
	onConnect,
	onOpenInspector,
	onOpenFile,
	projects,
	selectedProject,
	loadedCatalog,
}: {
	projectId?: string;
	parent: PublicCodexSession;
	parentTurnStatus: SessionTurnStatus;
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	onConnect: () => void;
	onOpenInspector: (view: InspectorView) => void;
	onOpenFile?: (path: string) => void;
	projects: Project[];
	selectedProject?: Project;
	loadedCatalog?: OpenChatSide["catalog"];
}) {
	const chat = useSideChat({ projectId, parent, harnessId });
	useEffect(() => {
		document.getElementById(SIDE_COMPOSER_INPUT_ID)?.focus();
	}, []);
	return (
		<SideChatFrame parentTurnStatus={parentTurnStatus}>
			<SessionLauncher
				variant="side"
				session={chat.session}
				busy={chat.pending}
				harnessId={harnessId}
				onHarnessIdChange={onHarnessIdChange}
				onSend={(text, modelId, options) =>
					chat.send(text, modelId, {
						...(options?.reasoningId
							? { reasoningId: options.reasoningId }
							: {}),
						...(options?.speed ? { speed: options.speed } : {}),
						...(options?.alternateContext !== undefined
							? { alternateContext: options.alternateContext }
							: {}),
						...(options?.userMessageId
							? { userMessageId: options.userMessageId }
							: {}),
					})
				}
				onConnect={onConnect}
				onStop={chat.stop}
				onOpenInspector={onOpenInspector}
				onOpenFile={onOpenFile}
				projects={projects}
				selectedProject={selectedProject}
				onSelectProject={() => {}}
				loadedCatalog={loadedCatalog}
				onRemoveQueued={chat.removeQueued}
				onEditQueued={chat.editQueued}
				onSendQueued={chat.sendQueued}
			/>
		</SideChatFrame>
	);
}
