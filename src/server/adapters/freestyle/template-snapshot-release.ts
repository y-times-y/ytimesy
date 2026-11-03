import { type Freestyle, FreestyleApiError } from "freestyle";
import { database } from "../database";

/** A replaced template stays a day, so a chat copy started from it just before the switch still finds it. */
const REPLACED_GRACE = "1 day";

/**
 * Deletes the snapshots of environment builds a newer ready build replaced
 * more than a day ago, unless anything still names them (a workspace
 * template, a recycled chat, a product setting). Without this every rebuild
 * leaves its snapshot on the provider forever. The build row keeps its
 * snapshot_id (a chat's checkout commit is looked up by it); only the
 * provider snapshot goes, and snapshot_released_at records that once.
 */
export async function releaseReplacedTemplateSnapshots(client: Freestyle) {
	const { rows } = await database().query<{
		id: string;
		snapshot_id: string;
		provider_ref: string | null;
	}>(
		`select b.id,b.snapshot_id,b.provider_ref from environment_build b
		 where b.status='ready' and b.snapshot_id is not null and b.snapshot_released_at is null
		   and exists (select 1 from environment_build n where n.workspace_id=b.workspace_id
		     and n.status='ready' and n.completed_at > b.completed_at
		     and n.completed_at < now()-interval '${REPLACED_GRACE}')
		   and not exists (select 1 from workspace w where w.template_snapshot_id=b.snapshot_id)
		   and not exists (select 1 from workspace_retention r where r.snapshot_id=b.snapshot_id)
		   and not exists (select 1 from product_setting p where trim(p.value)=b.snapshot_id)
		 order by b.completed_at limit 16`,
	);
	for (const row of rows) {
		try {
			const snapshot = await client.vms.snapshots.get(row.snapshot_id);
			// Only a private snapshot this build's own machine made; any other is
			// left alone (and not retried).
			if (!snapshot.public && snapshot.sourceVmId === row.provider_ref)
				await client.vms.snapshots.delete(row.snapshot_id);
			else
				console.warn(
					"Replaced template snapshot kept: ownership not verified.",
					{
						buildId: row.id,
					},
				);
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				throw error;
		}
		await database().query(
			"update environment_build set snapshot_released_at=now() where id=$1",
			[row.id],
		);
	}
	return rows.length;
}
