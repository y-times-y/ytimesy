/**
 * A chat list that fails to read is read again, twice, after 1 s and 2 s.
 * The app's default is no retry (routes/__root.tsx), which is right for most
 * reads; this list decides the sidebar and the Super agent screen, and the
 * server now reports a failed read instead of answering with an empty list.
 */
export const chatListRetry = {
	retry: 2,
	retryDelay: (attempt: number) => 1000 * 2 ** attempt,
} as const;
