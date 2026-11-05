const CHAT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_PATH = /^\/chat\/([^/]+)\/?$/;

/**
 * A chat's address is `/chat/<id>`. The page itself is one route that reads
 * `/?chat=<id>` (older links, memory sources and GitHub wake-ups still use it),
 * so the router maps one to the other: that keeps a switch between chats on
 * one page instead of mounting a new one.
 */

/** The chat a browser address names, as `/chat/<id>` or `/?chat=<id>`; null for any other address. */
export function chatIdInAddress(location: {
	readonly pathname: string;
	readonly search: string;
}): string | null {
	const fromPath = CHAT_PATH.exec(location.pathname)?.[1];
	if (fromPath) return CHAT_ID.test(fromPath) ? fromPath : null;
	if (location.pathname !== "/") return null;
	const fromQuery = new URLSearchParams(location.search).get("chat");
	return fromQuery && CHAT_ID.test(fromQuery) ? fromQuery : null;
}

/** The router's input: `/chat/<id>` is the page with that chat open. */
export function chatAddressInput({ url }: { url: URL }): URL | undefined {
	const id = CHAT_PATH.exec(url.pathname)?.[1];
	if (!id || !CHAT_ID.test(id)) return undefined;
	url.pathname = "/";
	url.searchParams.set("chat", id);
	return url;
}

/** The router's output: the page with a chat open is shown as `/chat/<id>`. */
export function chatAddressOutput({ url }: { url: URL }): URL | undefined {
	if (url.pathname !== "/") return undefined;
	const id = url.searchParams.get("chat");
	if (!id || !CHAT_ID.test(id)) return undefined;
	url.searchParams.delete("chat");
	url.pathname = `/chat/${id}`;
	return url;
}

/** `/chat/<id>` (with the other parameters kept), or `/` when no chat is open. */
export function chatAddress(
	current: { readonly search: string; readonly hash: string },
	chatId: string | null,
): string {
	const params = new URLSearchParams(current.search);
	params.delete("chat");
	const query = params.toString();
	return `${chatId ? `/chat/${chatId}` : "/"}${query ? `?${query}` : ""}${current.hash}`;
}
