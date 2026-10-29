import type { SessionTurnStatus } from "./session-item";
import type { ChatWaitingOn } from "./sidebar-chats";

/** A chat as the finish alerts watch it. */
export type WatchedChat = {
	readonly id: string;
	readonly title: string;
	readonly running: boolean;
	readonly turnStatus?: SessionTurnStatus;
	readonly waitingOn?: ChatWaitingOn | null;
};

export type FinishedChat = {
	readonly id: string;
	readonly title: string;
	readonly outcome: "finished" | "failed" | "needs-you";
};

/** Chats that were running at the last look and no longer are. */
export function finishedChats(
	wasRunning: ReadonlySet<string>,
	chats: readonly WatchedChat[],
): FinishedChat[] {
	return chats
		.filter((chat) => wasRunning.has(chat.id) && !chat.running)
		.map((chat) => ({
			id: chat.id,
			title: chat.title,
			outcome:
				chat.waitingOn && chat.waitingOn !== "failed"
					? "needs-you"
					: chat.turnStatus === "failed" || chat.waitingOn === "failed"
						? "failed"
						: "finished",
		}));
}

export function finishedChatBody(outcome: FinishedChat["outcome"]): string {
	return { finished: "Finished", failed: "Failed", "needs-you": "Needs you" }[
		outcome
	];
}

const UNSEEN_MARK = "● ";

/** The tab's title with a dot while a finish went unseen, without one after. */
export function tabTitle(title: string, unseen: boolean): string {
	const plain = title.startsWith(UNSEEN_MARK)
		? title.slice(UNSEEN_MARK.length)
		: title;
	return unseen ? `${UNSEEN_MARK}${plain}` : plain;
}
