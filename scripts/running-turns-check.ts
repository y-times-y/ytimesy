import pg from "pg";
import { supabaseCertificate } from "./supabase-certificate";

/**
 * Pre-flight for a production deploy: which chats are running a turn right
 * now. A deploy never waits for them: each Worker takes one new version,
 * Durable Objects move to it once idle, and an interrupted step resumes from
 * its checkpoint. The count is only reported, so the operator knows.
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

/** Whether the deploy may continue, and what to tell the operator. Running turns never block it; an unreadable count still does (that is a database fault, not a busy chat). */
export function runningTurnsDecision(
	check: RunningTurnsCheck,
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
	return {
		proceed: true,
		message: `${summary} Deploying anyway: they resume from their checkpoint.`,
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
			ssl: {
				ca: supabaseCertificate(process.env, caPath),
				rejectUnauthorized: true,
			},
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
