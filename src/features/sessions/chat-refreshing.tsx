import { createContext, useContext } from "react";

/**
 * True while the open chat shows the browser's saved copy and the server's
 * view has not arrived (domain/chat-refresh.ts). What would read as live
 * (spinners, "working") waits for the real state instead of showing an old one.
 */
export const ChatRefreshingContext = createContext(false);

export function useChatRefreshing() {
	return useContext(ChatRefreshingContext);
}
