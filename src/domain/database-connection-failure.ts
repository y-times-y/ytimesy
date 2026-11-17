/**
 * A database connection that could not be had before any statement ran: the
 * pool's connect timeout ("timeout exceeded when trying to connect"), a
 * handshake cut short, or the server refusing at startup (57P03 cannot
 * connect now, 53300 too many connections). The statement never reached the
 * server, so repeating it is always safe.
 */
const CONNECT_FAILURE_MESSAGE =
	/timeout exceeded when trying to connect|connection terminated due to connection timeout|too many (?:clients|connections)|the database system is (?:starting up|shutting down)/i;

export function isConnectFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message, syscall } = error as {
		code?: unknown;
		message?: unknown;
		syscall?: unknown;
	};
	const text = typeof message === "string" ? message : "";
	if (["57P03", "53300"].includes(String(code))) return true;
	// ETIMEDOUT only counts for a socket connect; a read/write timeout may have
	// come mid-statement.
	if (
		String(code) === "ETIMEDOUT" &&
		(syscall === "connect" || /^connect\b/i.test(text))
	)
		return true;
	return CONNECT_FAILURE_MESSAGE.test(text);
}

export const DATABASE_CONNECTION_SEND_FAILURE =
	"Couldn't send that: the database connection timed out. Your message was kept; try again.";
