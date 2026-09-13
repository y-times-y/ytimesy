import { ArrowUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "./model-capabilities";
import { ProjectContext } from "./project-context";
import { SessionControls } from "./session-controls";
import { TaskInput } from "./task-input";

export function SessionLauncher({
	session,
	busy,
	onConnect,
	onSend,
}: {
	session: PublicCodexSession;
	busy: boolean;
	onConnect: () => void;
	onSend: (text: string, modelId: string) => void;
}) {
	const models = sessionModelsFromListed(session.models);
	const [attachments, setAttachments] = useState<File[]>([]);
	const [draft, setDraft] = useState("");
	const [modelId, setModelId] = useState(preferredSessionModelId(models));

	useEffect(() => {
		const listed = sessionModelsFromListed(session.models);
		setModelId((current) =>
			listed.some((model) => model.id === current)
				? current
				: preferredSessionModelId(listed),
		);
	}, [session.models]);

	function sendDraft() {
		const text = draft.trim();
		if (!text || !session.canSend || !modelId || busy) return;
		onSend(text, modelId);
		setDraft("");
	}

	return (
		<section className="session-launcher" aria-labelledby="session-title">
			<h1 id="session-title" className="sr-only">
				New session
			</h1>
			<AgentSetup session={session} busy={busy} onConnect={onConnect} />
			{session.messages.length > 0 && (
				<ol className="session-transcript" aria-label="Conversation">
					{session.messages.map((message) => (
						<li
							key={message.id ?? `${message.role}:${message.text}`}
							data-role={message.role}
						>
							<span>{message.role === "user" ? "You" : "Codex"}</span>
							<p>{message.text}</p>
						</li>
					))}
				</ol>
			)}
			<ProjectContext />
			<div className="session-composer">
				<TaskInput
					value={draft}
					onChange={setDraft}
					onSubmit={sendDraft}
					disabled={busy || !session.canSend}
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
					<button
						type="button"
						className="session-send"
						aria-label="Start session"
						disabled={!session.canSend || busy || !draft.trim() || !modelId}
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
	if (connection.status === "authenticated") {
		return (
			<p className="agent-setup" role="status">
				Codex connected
				{connection.planType ? ` · ${connection.planType}` : ""}. Models come
				from the agent.
			</p>
		);
	}
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
