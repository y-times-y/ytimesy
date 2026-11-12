import { useEffect, useRef } from "react";
import {
	finishedChatBody,
	finishedChats,
	tabTitle,
	type WatchedChat,
} from "#/domain/turn-finish-alerts";
import {
	requestNotificationPermission,
	showNotification,
} from "../app/safe-notification";

function pageAway() {
	return document.hidden || !document.hasFocus();
}

/**
 * A turn that finishes while the page is in the background puts a dot in the
 * tab's title until the page is back, and shows a desktop notification when
 * the browser allows them; clicking it opens that chat.
 */
export function useTurnFinishAlerts(
	chats: readonly WatchedChat[],
	onOpenChat: (chatId: string) => void,
) {
	const wasRunning = useRef<ReadonlySet<string>>(new Set());
	const openChat = useRef(onOpenChat);
	openChat.current = onOpenChat;
	// Every render: a cheap look at which chats stopped running since the last.
	useEffect(() => {
		const finished = finishedChats(wasRunning.current, chats);
		wasRunning.current = new Set(
			chats.filter((chat) => chat.running).map((chat) => chat.id),
		);
		if (finished.length === 0 || !pageAway()) return;
		document.title = tabTitle(document.title, true);
		for (const chat of finished) {
			showNotification(
				chat.title,
				{
					body: finishedChatBody(chat.outcome),
					tag: `ytimesy-turn-${chat.id}`,
					icon: "/brand/github-avatar.png",
				},
				() => openChat.current(chat.id),
			);
		}
	});

	useEffect(() => {
		const back = () => {
			if (!pageAway()) document.title = tabTitle(document.title, false);
		};
		document.addEventListener("visibilitychange", back);
		window.addEventListener("focus", back);
		return () => {
			document.removeEventListener("visibilitychange", back);
			window.removeEventListener("focus", back);
		};
	}, []);
}

/** Asks once, from a send, whether finished turns may show desktop notifications. */
export function askForFinishNotifications() {
	requestNotificationPermission();
}
