import { ArrowUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionItemId } from "#/domain/ids";
import {
	type SessionItem,
	type SessionTurnStatus,
	visibleSessionItems,
} from "#/domain/session-item";
import { SessionTimeline } from "./session-timeline";
import { TaskInput } from "./task-input";

export function SideChatPanel({
	items,
	turnStatus,
	canSend,
	mainTurnRunning,
	busy,
	queued,
	onClose,
	onSend,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	canSend: boolean;
	mainTurnRunning: boolean;
	busy: boolean;
	queued: boolean;
	onClose: () => void;
	onSend: (text: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const [optimisticItems, setOptimisticItems] = useState<SessionItem[]>([]);
	const visible = visibleSessionItems(items, optimisticItems);

	useEffect(() => {
		setOptimisticItems((current) =>
			current.filter(
				(item) =>
					item.kind !== "userMessage" ||
					!items.some(
						(existing) =>
							existing.kind === "userMessage" && existing.text === item.text,
					),
			),
		);
	}, [items]);

	function sendDraft() {
		const text = draft.trim();
		if (!text || !canSend || busy) return;
		setOptimisticItems((current) => [
			...current,
			{
				kind: "userMessage",
				id: SessionItemId(`side-local-${crypto.randomUUID()}`),
				text,
			},
		]);
		onSend(text);
		setDraft("");
	}

	return (
		<aside className="side-chat" aria-label="Side chat">
			<header className="side-chat-header">
				<div>
					<h2>Side chat</h2>
					<p className="side-chat-lede">
						Asks without interrupting the current run. Defaults to read, search,
						and answer.
					</p>
				</div>
				<button
					type="button"
					className="side-chat-close"
					aria-label="Close side chat"
					onClick={onClose}
				>
					<X size={16} />
				</button>
			</header>
			<SessionTimeline items={visible} turnStatus={turnStatus} fill />
			{queued || mainTurnRunning ? (
				<p className="side-chat-queue" role="status">
					{queued
						? "Queued. This sends when the current run finishes."
						: "Will not interrupt the current run."}
				</p>
			) : null}
			<div className="side-chat-composer">
				<TaskInput
					value={draft}
					onChange={setDraft}
					onSubmit={sendDraft}
					disabled={busy || !canSend}
					placeholder="Ask a side question"
					label="Side chat message"
				/>
				<button
					type="button"
					className="session-send"
					aria-label="Send side chat"
					disabled={!canSend || busy || !draft.trim()}
					onClick={sendDraft}
				>
					<span className="send-face">
						<ArrowUp className="size-4" />
					</span>
				</button>
			</div>
		</aside>
	);
}
