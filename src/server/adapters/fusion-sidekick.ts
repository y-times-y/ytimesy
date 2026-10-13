import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { downloadCheckpoint, uploadCheckpoint } from "./checkpoints/storage";
import { database } from "./database";

type StoredSidekick = { modelId: string; messages: ModelMessage[] };

/** The sidekick's context for a Fusion lead session, or a fresh one. */
export async function loadSidekick(
	userId: string,
	sessionId: string,
	defaultModelId: string,
): Promise<StoredSidekick> {
	const result = await database().query<{
		model_id: string;
		checkpoint_path: string;
	}>(
		"select model_id, checkpoint_path from fusion_sidekick where session_id=$1 and user_id=$2",
		[sessionId, userId],
	);
	const row = result.rows[0];
	if (!row) return { modelId: defaultModelId, messages: [] };
	const payload = JSON.parse(
		await downloadCheckpoint(userId, sessionId, row.checkpoint_path),
	) as { messages: ModelMessage[] };
	return { modelId: row.model_id, messages: payload.messages };
}

export async function saveSidekick(
	userId: string,
	sessionId: string,
	state: StoredSidekick,
) {
	const path = await uploadCheckpoint(
		userId,
		sessionId,
		`fusion-sidekick-${randomUUID()}`,
		JSON.stringify({ version: 1, messages: state.messages }),
	);
	await database().query(
		`insert into fusion_sidekick(session_id,user_id,model_id,checkpoint_path) values($1,$2,$3,$4)
		 on conflict(session_id) do update set model_id=excluded.model_id,
		 checkpoint_path=excluded.checkpoint_path, updated_at=now()
		 where fusion_sidekick.user_id=excluded.user_id`,
		[sessionId, userId, state.modelId, path],
	);
}
