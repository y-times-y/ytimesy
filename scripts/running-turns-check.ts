import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * Pre-flight for a production deploy: which chats are running a turn right
 * now. A deploy replaces the Workers and a Durable Object that restarts mid
 * step can lose a turn, so the operator decides knowingly.
 */
export type RunningTurnsCheck =
	| { readonly kind: "counted"; readonly chatIds: readonly string[] }
	| { readonly kind: "unreadable"; readonly reason: string };

export type RunningTurnsDecision =
	| { readonly proceed: true; readonly message: string }
	| { readonly proceed: false; readonly message: string };

const SHOWN_IDS = 10;

/** First 8 characters only: enough to find the chat, nothing from its content. */
export function shortChatId(id: string) {
	return id.slice(0, 8);
}

/** Whether the deploy may continue, and what to tell the operator. Never continues on an unreadable count. */
export function runningTurnsDecision(
	check: RunningTurnsCheck,
	allowRunningTurns: boolean,
): RunningTurnsDecision {
	if (check.kind === "unreadable")
		return {
			proceed: false,
			message: `Could not count running turns (${check.reason}). Refusing to deploy: retry, or check the database by hand first.`,
		};
	const ids = [...new Set(check.chatIds)];
	if (ids.length === 0)
		return { proceed: true, message: "No chat is running a turn." };
	const shown = ids.slice(0, SHOWN_IDS).map(shortChatId).join(", ");
	const more =
		ids.length > SHOWN_IDS ? `, +${ids.length - SHOWN_IDS} more` : "";
	const summary = `${ids.length} chat${ids.length === 1 ? " is" : "s are"} running a turn (${shown}${more}).`;
	return allowRunningTurns
		? {
				proceed: true,
				message: `${summary} Continuing because --allow-running-turns was passed.`,
			}
		: {
				proceed: false,
				message: `${summary} Refusing to deploy. Wait for them to finish, or pass --allow-running-turns.`,
			};
}

/** Read-only and fast: one select, 5 s to connect and 5 s to answer. */
export async function readRunningTurns(
	databaseUrl: string,
	caPath = process.env.SUPABASE_CA_PATH ?? ".secrets/supabase-ca.crt",
): Promise<RunningTurnsCheck> {
	let client: pg.Client | undefined;
	try {
		client = new pg.Client({
			connectionString: databaseUrl
				.replace(/[?&]sslrootcert=[^&]*/, "")
				.replace(/[?&]sslmode=[^&]*/, ""),
			ssl: { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true },
			connectionTimeoutMillis: 5_000,
			statement_timeout: 5_000,
			options: "-c default_transaction_read_only=on",
		});
		await client.connect();
		const result = await client.query<{ session_id: string }>(
			"select distinct session_id from api_turn where state = 'running'",
		);
		return {
			kind: "counted",
			chatIds: result.rows.map((row) => row.session_id),
		};
	} catch (error) {
		return {
			kind: "unreadable",
			reason: error instanceof Error ? error.name : "unknown error",
		};
	} finally {
		await client?.end().catch(() => {});
	}
}
