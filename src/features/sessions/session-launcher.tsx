import { ArrowUp, Square, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import {
	harnessRequiresAccountLogin,
	selectedHarnessIsConnected,
} from "#/domain/harness-access";
import { SessionItemId } from "#/domain/ids";
import {
	lastUserMessageText,
	type SessionItem,
	visibleSessionItems,
} from "#/domain/session-item";
import {
	composerSlashCommands,
	matchingSlashCommands,
	parseSlashDraft,
	type SlashCommand,
} from "#/domain/slash-command";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import type { Project } from "../../domain/projects";
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "./model-capabilities";
import { ProjectContext } from "./project-context";
import { SessionControls } from "./session-controls";
import { SessionTimeline } from "./session-timeline";
import { SlashCommandPalette } from "./slash-command-palette";
import { TaskInput } from "./task-input";

export type InspectorView = "diff" | "terminal" | "desktop";

export function SessionLauncher({
	session,
	busy,
	harnessId,
	onHarnessIdChange,
	apiKeyHints,
	onConnect,
	onSaveApiKey,
	onSend,
	onStop,
	onOpenSideChat,
	onOpenInspector,
	projects,
	selectedProject,
	onSelectProject,
}: {
	session: PublicCodexSession;
	busy: boolean;
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	apiKeyHints: Readonly<Partial<Record<AgentProviderId, string>>>;
	onConnect: () => void;
	onSaveApiKey: (harnessId: AgentProviderId, apiKey: string) => void;
	onSend: (text: string, modelId: string) => void;
	onStop: () => void;
	onOpenSideChat: (question?: string) => void;
	onOpenInspector: (view: InspectorView) => void;
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
}) {
	const harnessReady = selectedHarnessIsConnected(
		session.connection,
		harnessId,
	);
	const models = harnessReady ? sessionModelsFromListed(session.models) : [];
	const [attachments, setAttachments] = useState<File[]>([]);
	const [draft, setDraft] = useState("");
	const [modelId, setModelId] = useState(preferredSessionModelId(models));
	const selectedModel = models.find((model) => model.id === modelId);
	const [optimisticItems, setOptimisticItems] = useState<SessionItem[]>([]);
	const [slashIndex, setSlashIndex] = useState(0);
	const items = visibleSessionItems(session.items, optimisticItems);
	const lastUserText = lastUserMessageText(items);
	const chatLayout =
		session.connection.status === "authenticated" || items.length > 0;
	const slashDraft = parseSlashDraft(draft);
	const slashCommands = useMemo(
		() =>
			composerSlashCommands({
				authenticated: harnessReady,
				turnRunning: session.turnStatus === "running",
				canSend: harnessReady && session.canSend,
				hasLastUserMessage: Boolean(lastUserText),
				hasModels: models.length > 0,
				publicationReady: false,
			}),
		[
			lastUserText,
			models.length,
			harnessReady,
			session.canSend,
			session.turnStatus,
		],
	);
	const visibleSlashCommands = slashDraft
		? matchingSlashCommands(slashDraft, slashCommands)
		: [];

	useEffect(() => {
		if (!draft.startsWith("/")) {
			setSlashIndex(0);
			return;
		}
		setSlashIndex(0);
	}, [draft]);

	useEffect(() => {
		if (!harnessReady) {
			setModelId("");
			return;
		}
		const listed = sessionModelsFromListed(session.models);
		setModelId((current) =>
			listed.some((model) => model.id === current)
				? current
				: preferredSessionModelId(listed),
		);
	}, [harnessReady, session.models]);

	useEffect(() => {
		setOptimisticItems((current) =>
			current.filter(
				(item) =>
					item.kind !== "userMessage" ||
					!session.items.some(
						(existing) =>
							existing.kind === "userMessage" && existing.text === item.text,
					),
			),
		);
	}, [session.items]);

	function sendText(text: string) {
		if (!text || !harnessReady || !session.canSend || !modelId || busy) return;
		setOptimisticItems((current) => [
			...current,
			{
				kind: "userMessage",
				id: SessionItemId(`local-${crypto.randomUUID()}`),
				text,
			},
		]);
		onSend(text, modelId);
		setDraft("");
	}

	function sendDraft() {
		if (slashDraft) {
			const command = visibleSlashCommands[slashIndex];
			if (command) runSlashCommand(command);
			return;
		}
		sendText(draft.trim());
	}

	function runSlashCommand(command: SlashCommand) {
		if (command.availability !== "ready") return;
		const argument = slashDraft?.argument ?? "";
		if (command.id === "side" || command.id === "btw") {
			onOpenSideChat(argument || undefined);
			setDraft("");
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
			setSlashIndex((index) => (index + 1) % visibleSlashCommands.length);
			return true;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setSlashIndex(
				(index) =>
					(index - 1 + visibleSlashCommands.length) %
					visibleSlashCommands.length,
			);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setDraft("");
			return true;
		}
		if (event.key === "Tab" || event.key === "Enter") {
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
			data-layout={chatLayout ? "chat" : "empty"}
		>
			<h1 id="session-title" className="sr-only">
				Session
			</h1>
			<SessionTimeline
				items={items}
				turnStatus={session.turnStatus}
				fill={chatLayout}
			/>
			<div className="session-dock">
				{visibleSlashCommands.length === 0 ? (
					<ProjectContext
						projects={projects}
						selectedProject={selectedProject}
						onSelectProject={onSelectProject}
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
											onClick={() =>
												setAttachments((files) =>
													files.filter((_, fileIndex) => fileIndex !== index),
												)
											}
										>
											<X size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
						<div className="session-toolbar">
							<SessionControls
								harnessId={harnessId}
								onHarnessIdChange={onHarnessIdChange}
								connection={session.connection}
								apiKeyHints={apiKeyHints}
								busy={busy}
								onConnect={onConnect}
								onSaveApiKey={onSaveApiKey}
								models={models}
								modelId={modelId}
								onModelIdChange={setModelId}
								onAttachFiles={(selected) =>
									setAttachments((files) => {
										const additions = selected.filter(
											(file) =>
												!files.some(
													(existing) =>
														existing.name === file.name &&
														existing.size === file.size &&
														existing.lastModified === file.lastModified,
												),
										);
										return [...files, ...additions];
									})
								}
							/>
							{session.turnStatus === "running" ? (
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
							) : (
								<button
									type="button"
									className="session-send"
									aria-label="Send"
									disabled={
										!harnessReady ||
										!session.canSend ||
										busy ||
										!draft.trim() ||
										!modelId ||
										Boolean(slashDraft)
									}
									title={
										harnessReady
											? session.canSend
												? "Send task"
												: "Wait for this harness to finish starting"
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
							)}
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
