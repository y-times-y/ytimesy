import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUp, Square, X } from "lucide-react";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { connectedProviderId } from "#/domain/agent-connection";
import { PLAN_APPROVAL_TEXT } from "#/domain/agent-plan";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { recordedContextUsage } from "#/domain/api-progress";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import {
	canResumeDisconnectedFollowUp,
	composerCanStartSignIn,
	composerSendIsEnabled,
	harnessLoginShouldShow,
	harnessRequiresAccountLogin,
	selectedHarnessIsConnected,
} from "#/domain/harness-access";
import { SessionItemId } from "#/domain/ids";
import {
	composerModelIdForCatalog,
	listedModelDisplayName,
} from "#/domain/listed-model";
import {
	type IncomingAttachment,
	safeAttachmentName,
} from "#/domain/message-attachment";
import { FAILOVER_CONTINUE_TEXT } from "#/domain/model-failover";
import type { Project } from "#/domain/projects";
import {
	secretDeclinedText,
	secretProvidedText,
} from "#/domain/secret-request";
import {
	lastUserMessageText,
	type SessionItem,
	sessionUsesFollowUpLayout,
	visibleSessionItems,
} from "#/domain/session-item";
import {
	composerSlashCommands,
	exactSlashCommand,
	expandProjectCommand,
	parseSlashDraft,
	type SlashCommand,
	slashMenuCommands,
} from "#/domain/slash-command";
import { captureAnalytics } from "#/features/analytics/client";
import { authClient } from "#/features/auth/client";
import { listChatEvidence } from "#/features/evidence/evidence.fn";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { listProjectCommandsFn } from "../workspace/explorer.fn";
import { saveProjectSecretFn } from "../workspace/project-secrets.fn";
import {
	getConversationRecoveryPoints,
	restoreConversationPoint,
} from "./agent-session.fn";
import { attachmentLimitError, encodeAttachments } from "./attachment-encoding";
import { ContextUsage } from "./context-usage";
import { ConversationRecovery } from "./conversation-recovery";
import { HarnessLogin } from "./harness-login";
import type { MemoryMarkerActions } from "./memory-markers";
import {
	type ComposerSpeed,
	composerListedModels,
	resolveReasoningLevel,
	sessionModelsFromListed,
} from "./model-capabilities";
import { getAgentModelCatalog } from "./model-catalog.fn";
import { ProjectContext } from "./project-context";
import { SessionControls } from "./session-controls";
import { SessionTimeline } from "./session-timeline";
import { SlashCommandPalette } from "./slash-command-palette";
import { TaskInput } from "./task-input";

type InspectorView = "files" | "diff" | "terminal" | "desktop";

const ATTACHMENTS_ONLY_TEXT = "See the attached files.";

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
	onRecovered,
	initialDraft = "",
	childTasks = [],
	projects,
	selectedProject,
	onSelectProject,
	listedTitle,
	projectPickerOpen,
	onProjectPickerOpenChange,
	memoryActions,
	onRemoveQueued,
}: {
	/** Memory lines recalled or saved by this chat's turns: open, undo, check. */
	memoryActions?: MemoryMarkerActions;
	/** Takes back a message still waiting behind the running turn. */
	onRemoveQueued?: (messageId: string) => void;
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
			readonly approvesPlan?: boolean;
			/** Continue on the fallback route the user approved after an outage. */
			readonly continueOn?: string;
			readonly userMessageId?: string;
			readonly attachments?: readonly IncomingAttachment[];
		},
	) => Promise<ComposerSendResult> | undefined;
	onConnect: () => void;
	onStop: () => void;
	onOpenInspector: (view: InspectorView) => void;
	onOpenFile?: (path: string) => void;
	onRecovered?: (sessionId: string, prompt: string | null) => Promise<void>;
	initialDraft?: string;
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
	});
	const models = useMemo(
		() =>
			sessionModelsFromListed(
				composerListedModels({
					sessionModels: session.models,
					catalogModels: catalog.data ?? [],
					rememberedModels: listedCatalog,
					sessionConnected:
						connectedProviderId(session.connection) === harnessId,
				}),
			),
		[
			session.models,
			session.connection,
			harnessId,
			listedCatalog,
			catalog.data,
		],
	);
	const [attachments, setAttachments] = useState<File[]>([]);
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
	// A message with only attachments still needs words for the transcript and model.
	const sendableDraft = (text: string) =>
		text || (attachments.length ? ATTACHMENTS_ONLY_TEXT : "");
	const loadRecovery = useServerFn(getConversationRecoveryPoints);
	const recoverPoint = useServerFn(restoreConversationPoint);
	const recoveryPoints = useQuery({
		queryKey: [
			"conversation-recovery",
			selectedProject?.id,
			session.agentSessionId,
			session.items.length,
			session.turnStatus,
		],
		enabled:
			!!selectedProject?.id &&
			!!session.agentSessionId &&
			(harnessId === "codex" || harnessId === "api"),
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
	const loadEvidence = useServerFn(listChatEvidence);
	// Pull request evidence (prEvidence) arrives after the turn, from a background job.
	const chatEvidence = useQuery({
		queryKey: [
			"chat-evidence",
			selectedProject?.id,
			session.agentSessionId,
			session.turnStatus,
		],
		enabled: !!selectedProject?.id && !!session.agentSessionId,
		queryFn: () => {
			if (!selectedProject || !session.agentSessionId)
				return { enabled: false, evidence: [] };
			return loadEvidence({
				data: {
					projectId: selectedProject.id,
					sessionId: session.agentSessionId,
				},
			});
		},
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data?.enabled) return false;
			return data.evidence.some((record) => record.status === "capturing")
				? 10_000
				: 30_000;
		},
	});
	const [draft, setDraft] = useState(initialDraft);
	const loadProjectCommands = useServerFn(listProjectCommandsFn);
	const saveProjectSecret = useServerFn(saveProjectSecretFn);
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
	const items = visibleSessionItems(session.items, optimisticItems);
	const turnStatus = session.turnStatus;
	const lastUserText = lastUserMessageText(items);
	const followUpLayout = sessionUsesFollowUpLayout({
		items,
		turnStatus,
		listedTitle,
	});
	function composerCanSend(text: string, slashCommand: boolean) {
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
	const slashCommands = useMemo(
		() =>
			composerSlashCommands({
				authenticated: harnessReady,
				requiresAccountLogin: harnessRequiresAccountLogin(harnessId),
				turnRunning: turnStatus === "running",
				canSend: composerReady,
				hasLastUserMessage: Boolean(lastUserText),
				hasModels: models.length > 0,
			}),
		[
			composerReady,
			harnessId,
			lastUserText,
			models.length,
			harnessReady,
			turnStatus,
		],
	);
	const allSlashCommands = [
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: Every edit of the draft resets the menu highlight.
	useEffect(() => {
		setSlashIndex(0);
		setSlashPicked(false);
	}, [draft]);

	useEffect(() => {
		const connectedHarness = connectedProviderId(session.connection);
		const lastUsedForCatalog =
			lastModelByHarness[harnessId] ||
			(connectedHarness === harnessId ? session.listedModelId : "");
		setModelId((current) => {
			const next = composerModelIdForCatalog({
				requestedId: current,
				catalog: models,
				lastUsedForCatalog,
				excludedIds: session.blockedListedModelIds,
			});
			return next === current ? current : next;
		});
	}, [
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

	function sendText(
		typed: string,
		plan?: { readonly approves: true },
		continueOn?: string,
	) {
		const text = sendableDraft(typed);
		if (!composerCanSend(text, false) || (!plan && attachmentError)) return;
		// An approval carries no files; the composer keeps any it holds.
		const files = plan ? [] : attachments;
		captureAnalytics("prompt_submitted", {
			runtime: harnessId,
			attempts: 1,
		});
		const retry = unsentSend.current;
		const userMessageId =
			!plan && retry && sameSend(retry, text, files)
				? retry.id
				: crypto.randomUUID();
		unsentSend.current = null;
		setOptimisticItems((current) => [
			...current,
			{
				kind: "userMessage",
				id: SessionItemId(userMessageId),
				text,
				// Sent during a run, it waits for the run's next step.
				...(turnStatus === "running" ? { queued: true as const } : {}),
				...(files.length
					? {
							attachments: files.map((file) => ({
								id: crypto.randomUUID(),
								name: safeAttachmentName(file.name),
								mediaType: file.type || "application/octet-stream",
								size: file.size,
							})),
						}
					: {}),
				...(plan ? { approvesPlan: true as const } : {}),
			},
		]);
		// Nothing was sent: take the message back and return what the user typed.
		const unsend = (restore: boolean) => {
			setOptimisticItems((current) =>
				current.filter((item) => item.id !== SessionItemId(userMessageId)),
			);
			if (plan || !restore) return;
			unsentSend.current = { id: userMessageId, text, files };
			setDraft((current) => (current.trim() ? current : typed));
			if (files.length)
				setAttachments((current) => (current.length ? current : files));
		};
		const reasoning = resolveReasoningLevel(selectedModel, reasoningId);
		const send = (encoded: readonly IncomingAttachment[]) =>
			onSend(text, modelId, {
				...(reasoning?.id ? { reasoningId: reasoning.id } : {}),
				...(speed ? { speed } : {}),
				...(plan ? { approvesPlan: true } : {}),
				...(continueOn ? { continueOn } : {}),
				userMessageId,
				...(encoded.length ? { attachments: encoded } : {}),
			})?.then((result) => {
				if (result !== "sent") unsend(result === "unsent");
			});
		// Approving from the plan card leaves a draft in progress alone.
		if (!plan) setDraft("");
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
		if (command.id === "custom" && command.template) {
			setDraft("");
			sendText(
				expandProjectCommand(command.template, slashDraft?.argument ?? ""),
			);
			return;
		}
		if (command.id === "stop") {
			onStop();
			setDraft("");
			return;
		}
		if (command.id === "retry" && lastUserText) {
			setDraft("");
			sendText(lastUserText);
			return;
		}
		if (command.id === "model") {
			setDraft("");
			document.getElementById("session-model-select")?.focus();
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
			<SessionTimeline
				recoveryControls={
					onRecovered && selectedProject && session.agentSessionId
						? (messageId) => {
								const point = recoveryPoints.data?.find(
									(point) => point.messageId === messageId,
								);
								if (!point) return null;
								return (
									<ConversationRecovery
										codeAvailable={point.codeAvailable}
										busy={busy || session.turnStatus === "running"}
										onRecover={async (mode) => {
											if (!session.agentSessionId)
												throw new Error("Session is unavailable.");
											const recovered = await recoverPoint({
												data: {
													projectId: selectedProject.id,
													sessionId: session.agentSessionId,
													messageId,
													mode,
												},
											});
											await onRecovered(recovered.id, recovered.prompt);
											if (recovered.prompt) setDraft(recovered.prompt);
											await recoveryPoints.refetch();
										}}
									/>
								);
							}
						: undefined
				}
				tasks={childTasks}
				evidence={chatEvidence.data?.evidence}
				memoryActions={memoryActions}
				items={items}
				turnStatus={turnStatus}
				fill={followUpLayout}
				onOpenFile={onOpenFile}
				planActions={{
					disabled: busy || turnStatus === "running",
					onApprove: () => sendText(PLAN_APPROVAL_TEXT, { approves: true }),
					onRevise: () =>
						document
							.querySelector<HTMLTextAreaElement>(".session-dock textarea")
							?.focus(),
				}}
				secretActions={
					selectedProject
						? {
								disabled: busy || turnStatus === "running",
								onSave: async ({ name, value, kind }) => {
									await saveProjectSecret({
										data: { projectId: selectedProject.id, name, value, kind },
									});
									sendText(secretProvidedText(name));
								},
								onDecline: (name) => sendText(secretDeclinedText(name)),
							}
						: undefined
				}
				failoverActions={{
					disabled: busy || turnStatus === "running",
					onContinue: (key) => sendText(FAILOVER_CONTINUE_TEXT, undefined, key),
				}}
				onRemoveQueued={onRemoveQueued}
			/>
			<div className="session-dock">
				{visibleSlashCommands.length === 0 ? (
					<ProjectContext
						projects={projects}
						selectedProject={selectedProject}
						onSelectProject={onSelectProject}
						projectLocked={followUpLayout}
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
					/>
				) : null}
				<div className="composer-shell">
					<div className="session-composer">
						{visibleSlashCommands.length > 0 ? (
							<SlashCommandPalette
								commands={visibleSlashCommands}
								activeIndex={slashIndex}
								onHover={setSlashIndex}
								onSelect={runSlashCommand}
							/>
						) : null}

						<TaskInput
							value={draft}
							onChange={setDraft}
							onSubmit={sendDraft}
							disabled={busy}
							placeholder={
								followUpLayout
									? "Follow up…"
									: "What would you like to work on?"
							}
							onKeyDown={handleComposerKey}
						/>
						{attachments.length > 0 && (
							<ul className="session-attachments" aria-label="Attached files">
								{attachments.map((file, index) => (
									<li key={`${file.name}-${file.lastModified}-${file.size}`}>
										<span title={file.name}>{file.name}</span>
										<button
											type="button"
											aria-label={`Remove ${file.name}`}
											onClick={() => {
												const next = attachments.filter(
													(_, fileIndex) => fileIndex !== index,
												);
												setAttachments(next);
												setAttachmentError(attachmentLimitError(next));
											}}
										>
											<X size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
						{attachmentError && (
							<p className="session-attachment-error" role="alert">
								{attachmentError}
							</p>
						)}
						<div className="session-toolbar">
							<SessionControls
								contextIndicator={
									harnessId === "codex" ||
									recordedContextUsage(session.items) ? (
										<ContextUsage
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
								connectionContent={
									harnessLoginShouldShow({
										harnessReady,
										harnessId,
										connection: session.connection,
									}) ? (
										<HarnessLogin
											harnessId={harnessId}
											connection={session.connection}
											busy={busy}
											onConnect={onConnect}
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
								modelId={modelId}
								listedModelId={modelId || session.listedModelId}
								onModelIdChange={setModelId}
								reasoningId={reasoningId}
								onReasoningIdChange={setReasoningId}
								speed={speed}
								onSpeedChange={setSpeed}
								onAttachFiles={(selected) => {
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
								}}
							/>
							{turnStatus === "running" ? (
								<button
									type="button"
									className="session-send"
									aria-label="Stop"
									title="Stop this run"
									onClick={onStop}
								>
									<span className="send-face send-face-stop">
										<Square className="size-3.5" fill="currentColor" />
									</span>
								</button>
							) : null}
							{turnStatus !== "running" ||
							draft.trim() ||
							attachments.length ? (
								<button
									type="button"
									className="session-send"
									aria-label="Send"
									disabled={
										Boolean(attachmentError) ||
										(draftCommand
											? draftCommand.availability !== "ready"
											: !composerCanSend(sendableDraft(draft.trim()), false))
									}
									title={
										turnStatus === "running"
											? "Queue this message for the running turn"
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
