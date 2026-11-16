import pg from "pg";
import { supabaseCertificate } from "./supabase-certificate";

/**
 * Pre-flight for a production deploy: which chats are running a turn right
 * now. An API-connection turn is not waited for: each Worker takes one new
 * version, Durable Objects move to it once idle, and an interrupted step
 * resumes from its checkpoint. A Claude turn cannot resume that way (its
 * `claude` process lives on a runner box and the chat's Durable Object
 * coordinates it), and on 2026-11-16 25 of 26 failed turns were Claude turns
 * that overlapped a deploy's Durable Object reset. The deploy therefore
 * waits, for a bounded time, for those (waitForClaudeTurns).
 */
export type RunningTurnsCheck =
	| {
			readonly kind: "counted";
			readonly chatIds: readonly string[];
			/** The chats among them whose turn runs a Claude model. */
			readonly claudeChatIds?: readonly string[];
	  }
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
		const result = await client.query<{ session_id: string; claude: boolean }>(
			"select session_id, bool_or(model_id like 'claude-%') as claude from api_turn where state = 'running' group by session_id",
		);
		return {
			kind: "counted",
			chatIds: result.rows.map((row) => row.session_id),
			claudeChatIds: result.rows
				.filter((row) => row.claude)
				.map((row) => row.session_id),
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

export const CLAUDE_TURN_WAIT_MS = 10 * 60_000;
const CLAUDE_TURN_POLL_MS = 15_000;

/**
 * Waits until no Claude turn is running, at most `timeoutMs`, then returns
 * the chats still running one (the deploy goes ahead with them, as it always
 * did). An unreadable count ends the wait: the caller's decision handles it.
 */
export async function waitForClaudeTurns(
	read: () => Promise<RunningTurnsCheck>,
	options: {
		readonly timeoutMs?: number;
		readonly pollMs?: number;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly log?: (message: string) => void;
	} = {},
) {
	const timeoutMs = options.timeoutMs ?? CLAUDE_TURN_WAIT_MS;
	const pollMs = options.pollMs ?? CLAUDE_TURN_POLL_MS;
	const sleep =
		options.sleep ??
		((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const log = options.log ?? console.log;
	let waited = 0;
	for (;;) {
		const check = await read();
		const running =
			check.kind === "counted" ? [...new Set(check.claudeChatIds ?? [])] : [];
		if (running.length === 0 || waited >= timeoutMs)
			return { waitedMs: waited, remaining: running.map(shortChatId) };
		if (waited === 0 || waited % 60_000 < pollMs)
			log(
				`Waiting for ${running.length} Claude turn${running.length === 1 ? "" : "s"} to finish before replacing the Workers (${running.map(shortChatId).join(", ")}); at most ${Math.round((timeoutMs - waited) / 60_000)} more minutes.`,
			);
		await sleep(pollMs);
		waited += pollMs;
	}
}
