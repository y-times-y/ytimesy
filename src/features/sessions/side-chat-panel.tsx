import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import type { AgentProviderId } from "#/domain/agent-provider";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { SessionTimeline } from "./session-timeline";
import { readSideChatFn, sendSideChatFn } from "./side-chat.fn";
import "./side-chat.css";

type SideChatSpeed = "fast" | "ultrafast";

/**
 * Closing unmounts this column only. The side session's turn keeps running,
 * and the main turn is not stopped.
 */
export function SideChatColumn({
	projectId,
	parentSessionId,
	harnessId,
	modelId,
	parentTurnStatus,
	reasoningId,
	speed,
	onClose,
}: {
	projectId?: string;
	parentSessionId: string | null;
	harnessId: AgentProviderId;
	modelId: string;
	parentTurnStatus: SessionTurnStatus;
	reasoningId?: string;
	speed?: SideChatSpeed;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const read = useServerFn(readSideChatFn);
	const send = useServerFn(sendSideChatFn);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = Boolean(projectId && parentSessionId && modelId);
	const query = useQuery({
		queryKey: ["side-chat", projectId, parentSessionId],
		enabled: Boolean(projectId && parentSessionId),
		queryFn: () =>
			read({
				data: {
					projectId: projectId as string,
					parentSessionId: parentSessionId as string,
					harnessId,
				},
			}),
		refetchInterval: (current) =>
			current.state.data?.view?.turnStatus === "running" ? 1000 : false,
	});
	useEffect(() => {
		document.getElementById("side-chat-draft")?.focus();
	}, []);
	async function submit() {
		const text = draft.trim();
		if (!text || !ready || pending || !projectId || !parentSessionId) return;
		setPending(true);
		setError(null);
		try {
			const sent = await send({
				data: {
					projectId,
					parentSessionId,
					harnessId,
					modelId,
					text,
					userMessageId: crypto.randomUUID(),
					...(reasoningId ? { variant: reasoningId } : {}),
					...(speed ? { speed } : {}),
				},
			});
			queryClient.setQueryData(["side-chat", projectId, parentSessionId], {
				sessionId: sent.sideSessionId,
				view: sent.view,
			});
			setDraft("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not send.");
		} finally {
			setPending(false);
		}
	}
	return (
		<SideChatPane
			items={query.data?.view?.items ?? []}
			turnStatus={query.data?.view?.turnStatus ?? "idle"}
			parentTurnStatus={parentTurnStatus}
			draft={draft}
			pending={pending}
			error={
				error ?? (query.error instanceof Error ? query.error.message : null)
			}
			canSend={ready}
			onDraft={setDraft}
			onSend={() => void submit()}
			onClose={onClose}
		/>
	);
}

export function SideChatPane({
	items,
	turnStatus,
	parentTurnStatus,
	draft,
	pending,
	error,
	canSend,
	onDraft,
	onSend,
	onClose,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	parentTurnStatus: SessionTurnStatus;
	draft: string;
	pending: boolean;
	error: string | null;
	canSend: boolean;
	onDraft: (value: string) => void;
	onSend: () => void;
	onClose: () => void;
}) {
	const idle = items.length === 0 && turnStatus !== "running";
	return (
		<aside className="side-chat" aria-label="Side chat">
			<header className="side-chat-header">
				<div className="side-chat-heading">
					<strong>Side chat</strong>
					<span>
						{parentTurnStatus === "running"
							? "Main is working. This chat does not interrupt it."
							: "Same tools as Main, in a separate conversation."}
					</span>
				</div>
				<button
					type="button"
					className="side-chat-close"
					aria-label="Close side chat"
					onClick={onClose}
				>
					Close
				</button>
			</header>
			{idle ? (
				<p className="side-chat-empty">
					{canSend
						? "Ask about the work in progress. Main keeps its own turn."
						: "Send a message in the main chat before using side chat."}
				</p>
			) : (
				<SessionTimeline items={items} turnStatus={turnStatus} fill />
			)}
			{error ? (
				<p className="side-chat-error" role="alert">
					{error}
				</p>
			) : null}
			<form
				className="side-chat-composer"
				onSubmit={(event) => {
					event.preventDefault();
					onSend();
				}}
			>
				<textarea
					id="side-chat-draft"
					value={draft}
					placeholder="Ask beside Main…"
					rows={2}
					disabled={!canSend || pending}
					onChange={(event) => onDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							onSend();
						}
					}}
				/>
				<button
					type="submit"
					className="side-chat-send"
					aria-label="Send to side chat"
					disabled={!canSend || pending || !draft.trim()}
				>
					Send
				</button>
			</form>
		</aside>
	);
}
