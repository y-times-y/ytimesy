/**
 * The chat this browser has open, so a reload opens it again. Without it the
 * server opened the first project's newest chat, wherever the person was.
 * The server checks the chat is the person's before opening it.
 */
export const OPEN_CHAT_COOKIE = "ytimesy-open-chat";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function openChatFromCookies(
	header: string | null | undefined,
): { projectId: string; chatId: string } | undefined {
	const raw = header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${OPEN_CHAT_COOKIE}=`))
		?.slice(OPEN_CHAT_COOKIE.length + 1);
	const [projectId, chatId] = raw?.split("~") ?? [];
	return projectId && chatId && UUID.test(projectId) && UUID.test(chatId)
		? { projectId, chatId }
		: undefined;
}

/** The cookie for the open chat; a new chat (no id) clears it. */
export function openChatCookie(projectId?: string, chatId?: string): string {
	return projectId && chatId && UUID.test(projectId) && UUID.test(chatId)
		? `${OPEN_CHAT_COOKIE}=${projectId}~${chatId}; path=/; max-age=2592000; samesite=lax`
		: `${OPEN_CHAT_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
