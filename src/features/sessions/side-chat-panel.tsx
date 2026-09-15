import { ArrowUp, Plus } from "lucide-react";
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
	isolated = false,
	busy,
	queued = false,
	onSend,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	canSend: boolean;
	mainTurnRunning: boolean;
	isolated?: boolean;
	busy: boolean;
	queued?: boolean;
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
		<section className="side-chat" aria-label="Side chat">
			<SessionTimeline items={visible} turnStatus={turnStatus} fill />
			{queued ? (
				<p className="side-chat-queue" role="status">
					Queued until the current run finishes.
				</p>
			) : isolated ? (
				<p className="side-chat-queue" role="status">
					Runs on its own workspace copy.
				</p>
			) : mainTurnRunning ? (
				<p className="side-chat-queue" role="status">
					Does not interrupt the current run.
				</p>
			) : null}
			<div className="side-chat-composer">
				<Plus size={16} aria-hidden="true" />
				<TaskInput
					value={draft}
					onChange={setDraft}
					onSubmit={sendDraft}
					disabled={busy}
					placeholder="Message side chat"
					label="Side chat message"
				/>
				<button
					type="button"
					className="side-chat-send"
					aria-label="Send side chat"
					disabled={!canSend || busy || !draft.trim()}
					onClick={sendDraft}
				>
					<ArrowUp size={16} />
				</button>
			</div>
		</section>
	);
}
