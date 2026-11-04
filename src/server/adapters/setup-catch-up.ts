import { freshMachineNotice } from "#/domain/fresh-machine-setup";
import { database } from "./database";
import { forgetPeerInboxObservation } from "./peer-inbox-observation";

/**
 * A chat whose machine booted without the project's template keeps one row
 * in its inbox (agent_peer_inbox, which every model step already watches),
 * so no schema change was needed. Its message is the catch-up's state:
 *
 * - `boot`: the machine is up; the turn starts its install once the checkout is there.
 * - `waiting`: that install started; the project's setup has not saved a recipe yet.
 * - `ready`: the setup saved one; the chat's next model step catches up.
 * - `running`: a step took it and is catching up.
 *
 * Until `ready` the row is stored as accepted, so the turn heartbeat's inbox
 * check (and so every step) ignores it; `ready` makes it pending, which the
 * next step's heartbeat sees. The step's inbox read (no extra query) reports
 * it and never injects it (isSetupCatchUpRow).
 */
const ROW_PREFIX = "setup-catch-up:";

/** A catch-up row: the step's inbox read reports it, never injects it. */
export const isSetupCatchUpRow = (id: string) => id.startsWith(ROW_PREFIX);

const rowId = (sessionId: string) => `${ROW_PREFIX}${sessionId}`;

/**
 * Records that this chat's machine booted without the template, and stages
 * the one notice its agent gets about it (delivered at its next model step).
 */
export async function markFreshChatMachine(sessionId: string) {
	await database().query(
		`insert into agent_peer_inbox(id,recipient_id,message,accepted) values
		 ($1,$3,'boot',true),($2,$3,$4,false) on conflict(id) do nothing`,
		[
			rowId(sessionId),
			`fresh-machine:${sessionId}`,
			sessionId,
			freshMachineNotice(),
		],
	);
	forgetPeerInboxObservation(sessionId);
}

/** Takes the start of a fresh machine's install; true once per machine. */
export async function takeFreshInstallStart(sessionId: string) {
	const result = await database().query(
		"update agent_peer_inbox set message='waiting' where id=$1 and message='boot' returning id",
		[rowId(sessionId)],
	);
	return (result.rowCount ?? 0) > 0;
}

/**
 * The project's setup saved its recipe: every chat of the project still
 * waiting for it catches up at its next model step. The chat that saved it
 * did the setup itself, so its own row is dropped.
 */
export async function readySetupCatchUps(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly savedInSessionId?: string;
}) {
	if (input.savedInSessionId)
		await database().query(
			"delete from agent_peer_inbox where id=$1 and recipient_id=$2",
			[rowId(input.savedInSessionId), input.savedInSessionId],
		);
	const result = await database().query<{ recipient_id: string }>(
		`update agent_peer_inbox q set message='ready', accepted=false
		 from agent_session s
		 where q.recipient_id=s.id and s.user_id=$1 and s.project_id=$2
		   and q.id='${ROW_PREFIX}'||s.id::text and q.message in ('boot','waiting')
		 returning q.recipient_id`,
		[input.userId, input.projectId],
	);
	for (const row of result.rows) forgetPeerInboxObservation(row.recipient_id);
	return result.rows.map((row) => row.recipient_id);
}

/** Takes this chat's catch-up when the setup is ready for it; true once. */
export async function takeSetupCatchUp(sessionId: string) {
	const result = await database().query(
		"update agent_peer_inbox set message='running', accepted=true where id=$1 and recipient_id=$2 and message='ready' returning id",
		[rowId(sessionId), sessionId],
	);
	return (result.rowCount ?? 0) > 0;
}

/** The chat caught up: nothing more to track. */
export async function finishSetupCatchUp(sessionId: string) {
	await database().query(
		"delete from agent_peer_inbox where id=$1 and recipient_id=$2",
		[rowId(sessionId), sessionId],
	);
}
