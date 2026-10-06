import {
	assertPatchIdentity,
	type TaskImportEvidence,
	type TaskPatchIdentity,
} from "#/domain/task-patch-evidence";
import { database } from "./database";

const reviewKey = (id: string) => `patch-review:${id}`;
const importKey = (patch: TaskPatchIdentity) =>
	`patch-import:${patch.taskId}:${patch.sha256}`;

/** Uses the existing durable command journal; review state and exact identity commit atomically. */
export async function acceptTaskPatch(
	userId: string,
	parentId: string,
	patch: TaskPatchIdentity,
) {
	assertPatchIdentity(patch);
	const result = await database().query(
		`with accepted as (
		 update agent_session set task_review_state='reviewed',updated_at=now()
		 where id=$1 and user_id=$2 and parent_session_id=$3 and task_state='done'
		 and exists (select 1 from agent_task_command_receipt v where v.parent_session_id=$1 and v.status='done'
		 and v.response->>'ok'='true' and v.response->'result'->>'type'='completion-verification'
		 and v.response->'result'->>'patchSha256'=$6 and v.response->'result'->>'base'=$7)
		 returning id
		) insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 select $3,$4,'done',$5::jsonb,now() from accepted
		 on conflict (parent_session_id,request_id) do update set response=excluded.response,status='done',completed_at=now(),updated_at=now()
		 returning request_id`,
		[
			patch.taskId,
			userId,
			parentId,
			reviewKey(patch.taskId),
			JSON.stringify({
				id: reviewKey(patch.taskId),
				ok: true,
				result: { type: "patch-review", ...patch },
			}),
			patch.sha256,
			patch.base,
		],
	);
	if (!result.rowCount)
		throw new Error(
			"Task changed or lacks authoritative baseline verification for the exact patch; acceptance was not recorded.",
		);
}

export async function recordTaskImport(
	userId: string,
	destinationId: string,
	patch: TaskPatchIdentity,
) {
	assertPatchIdentity(patch);
	const key = importKey(patch);
	const result = await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
		 on conflict (parent_session_id,request_id) do update set response=excluded.response,status='done',completed_at=now(),updated_at=now()
		 returning request_id`,
		[
			destinationId,
			userId,
			key,
			JSON.stringify({
				id: key,
				ok: true,
				result: { type: "patch-import", destinationId, ...patch },
			}),
		],
	);
	if (!result.rowCount)
		throw new Error("Import destination is no longer available.");
}

/** Reads only evidence belonging to this owner's task tree, never arbitrary command results. */
export async function taskPatchEvidence(
	userId: string,
	sessionIds: readonly string[],
) {
	const reviews = new Map<string, TaskPatchIdentity>();
	const imports: TaskImportEvidence[] = [];
	if (!sessionIds.length) return { reviews, imports };
	const result = await database().query<{
		response: {
			result: TaskPatchIdentity & { type: string; destinationId?: string };
		};
	}>(
		`select receipt.response from agent_task_command_receipt receipt
		 join agent_session owner on owner.id=receipt.parent_session_id
		 where owner.user_id=$1 and owner.id=any($2::uuid[]) and receipt.status='done'
		 and (receipt.request_id like 'patch-review:%' or receipt.request_id like 'patch-import:%')`,
		[userId, sessionIds],
	);
	for (const row of result.rows) {
		const patch = row.response.result;
		assertPatchIdentity(patch);
		if (patch.type === "patch-review") reviews.set(patch.taskId, patch);
		if (patch.type === "patch-import" && patch.destinationId)
			imports.push({ ...patch, destinationId: patch.destinationId });
	}
	return { reviews, imports };
}
