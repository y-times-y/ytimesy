import { ArrowUp, Square, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
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
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "./model-capabilities";
import { ProjectContext } from "./project-context";
import { SessionControls } from "./session-controls";
import { SessionTimeline } from "./session-timeline";
import { SlashCommandPalette } from "./slash-command-palette";
import { TaskInput } from "./task-input";

export type InspectorView = "diff" | "terminal" | "preview";

export function SessionLauncher({
	session,
	busy,
	onConnect,
	onSend,
	onStop,
	onOpenSideChat,
	onOpenInspector,
}: {
	session: PublicCodexSession;
	busy: boolean;
	onConnect: () => void;
	onSend: (text: string, modelId: string) => void;
	onStop: () => void;
	onOpenSideChat: (question?: string) => void;
	onOpenInspector: (view: InspectorView) => void;
}) {
	const models = sessionModelsFromListed(session.models);
	const [attachments, setAttachments] = useState<File[]>([]);
	const [draft, setDraft] = useState("");
	const [modelId, setModelId] = useState(preferredSessionModelId(models));
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
				authenticated: session.connection.status === "authenticated",
				turnRunning: session.turnStatus === "running",
				canSend: session.canSend,
				hasLastUserMessage: Boolean(lastUserText),
				hasModels: models.length > 0,
				publicationReady: false,
			}),
		[
			lastUserText,
			models.length,
			session.canSend,
			session.connection.status,
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
		const listed = sessionModelsFromListed(session.models);
		setModelId((current) =>
			listed.some((model) => model.id === current)
				? current
				: preferredSessionModelId(listed),
		);
	}, [session.models]);

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
		if (!text || !session.canSend || !modelId || busy) return;
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
			command.id === "preview"
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
			<AgentSetup session={session} busy={busy} onConnect={onConnect} />
			<SessionTimeline
				items={items}
				turnStatus={session.turnStatus}
				fill={chatLayout}
			/>
			<div className="session-dock">
				<ProjectContext />
				<div className="composer-shell">
					{visibleSlashCommands.length > 0 ? (
						<SlashCommandPalette
							commands={visibleSlashCommands}
							activeIndex={slashIndex}
							onHover={setSlashIndex}
							onSelect={runSlashCommand}
						/>
					) : null}
					<div className="session-composer">
						<TaskInput
							value={draft}
							onChange={setDraft}
							onSubmit={sendDraft}
							disabled={
								busy || (!session.canSend && session.turnStatus !== "running")
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
										!session.canSend ||
										busy ||
										!draft.trim() ||
										!modelId ||
										Boolean(slashDraft)
									}
									title={
										session.canSend
											? "Send task"
											: "Connect Codex during setup to start a session"
									}
									onClick={sendDraft}
								>
									<span className="send-face">
										<ArrowUp className="size-4" />
									</span>
								</button>
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function AgentSetup({
	session,
	busy,
	onConnect,
}: {
	session: PublicCodexSession;
	busy: boolean;
	onConnect: () => void;
}) {
	const { connection } = session;
	if (connection.status === "authenticated") return null;
	if (connection.status === "awaiting_device_code") {
		return (
			<div className="agent-setup" role="status">
				<p>Authorize Codex, then this workspace will continue automatically.</p>
				<p>
					Open {connection.verificationUrl} and enter {connection.userCode}.
				</p>
			</div>
		);
	}
	if (connection.status === "failed") {
		return (
			<div className="agent-setup" role="alert">
				<p>{connection.message}</p>
				<button type="button" onClick={onConnect} disabled={busy}>
					Retry Codex
				</button>
			</div>
		);
	}
	return (
		<div className="agent-setup">
			<p>
				{session.snapshotAvailable
					? "A private Codex snapshot is ready. Connect to load models and send a task."
					: "Connect Codex to load models from the agent."}
			</p>
			<button type="button" onClick={onConnect} disabled={busy}>
				{busy ? "Connecting…" : "Connect Codex"}
			</button>
		</div>
	);
}
