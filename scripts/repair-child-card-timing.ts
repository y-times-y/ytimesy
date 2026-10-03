import { sessionItemsFromUnknown } from "#/domain/session-item";
import { closeDatabase, database } from "#/server/adapters/database";

// Only this reported, settled conversation is eligible. Never guess historical timestamps.
const sessionId = "a72e59f3-b0e7-4d08-8271-a97ae8512f32";
try {
	const db = database();
	const session = (
		await db.query(
			"select user_id,items,turn_status from agent_session where id=$1",
			[sessionId],
		)
	).rows[0];
	if (!session || session.turn_status === "running")
		throw new Error(
			"The reported conversation must be settled before timing repair.",
		);
	const turns = await db.query<{ created_at: Date; items: unknown }>(
		"select created_at,items from api_turn where session_id=$1 and user_id=$2 order by created_at",
		[sessionId, session.user_id],
	);
	const timings = new Map<string, number>();
	for (const turn of turns.rows) {
		const prompt = sessionItemsFromUnknown(turn.items)
			.filter((item) => item.kind === "userMessage")
			.at(-1);
		if (prompt && !timings.has(prompt.id))
			timings.set(prompt.id, new Date(turn.created_at).getTime());
	}
	let restored = 0;
	const items = sessionItemsFromUnknown(session.items).map((item) => {
		const startedAt = timings.get(item.id);
		if (item.kind !== "userMessage" || item.timing || startedAt == null)
			return item;
		restored++;
		return { ...item, timing: { startedAt } };
	});
	const saved = await db.query(
		"update agent_session set items=$3 where id=$1 and user_id=$2 and turn_status<>'running' and items=$4::jsonb and not exists(select 1 from api_turn where session_id=$1 and state in ('running','queued')) returning id",
		[
			sessionId,
			session.user_id,
			JSON.stringify(items),
			JSON.stringify(session.items),
		],
	);
	if (!saved.rowCount)
		throw new Error(
			"Conversation changed during repair; no data was overwritten.",
		);
	console.info(
		JSON.stringify({
			restoredPromptTimings: restored,
			source: "recorded api_turn creation times",
			transcriptTextChanged: false,
		}),
	);
} finally {
	await closeDatabase();
}
