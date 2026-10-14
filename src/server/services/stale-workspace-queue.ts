import { WORKSPACE_QUEUE_RECOVERY_SECONDS } from "#/domain/environment-build-limits";
import { database } from "../adapters/database";
import { recordWorkspaceEvent } from "../adapters/workspaces";

export const STALE_QUEUE_MESSAGE =
	"Environment setup never started. Retry to queue it again.";

/**
 * A prepare job that could not be handed off leaves its workspace queued with no
 * build. Fail it so the panel offers Retry; a running build or an existing
 * template is never touched.
 */
export async function recoverStaleQueuedWorkspaces(
	olderThanSeconds = WORKSPACE_QUEUE_RECOVERY_SECONDS,
) {
	const failed = await database().query<{ id: string; user_id: string }>(
		`update workspace w set status='failed',error_message=$2,updated_at=now()
		 where w.status='queued' and w.template_snapshot_id is null
		 and w.updated_at < now()-($1 * interval '1 second')
		 and not exists(select 1 from environment_build b where b.workspace_id=w.id and b.status='running')
		 returning w.id,w.user_id`,
		[olderThanSeconds, STALE_QUEUE_MESSAGE],
	);
	for (const row of failed.rows)
		await recordWorkspaceEvent(row.user_id, row.id, STALE_QUEUE_MESSAGE);
	return failed.rows.length;
}
