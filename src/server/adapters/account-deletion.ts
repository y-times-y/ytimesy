import { database } from "./database";

/**
 * Provider resources an account owns, collected before its rows are deleted:
 * chat, template, build and retained-recovery VMs, and the private snapshots
 * of its projects. Snapshots another account still references are left alone.
 */
export async function accountCleanupTargets(userId: string) {
	const result = await database().query<{
		vm_ids: string[] | null;
		snapshot_ids: string[] | null;
		session_ids: string[] | null;
	}>(
		`with owned_workspace as (select id, provider_ref, template_snapshot_id from workspace where user_id=$1),
		vms as (
			select provider_ref as id from agent_session where user_id=$1
			union select provider_ref from owned_workspace
			union select b.provider_ref from environment_build b join owned_workspace w on w.id=b.workspace_id
			union select vm_id from workspace_retention where user_id=$1
			union select vm_id from infrastructure_vm_admission where user_id=$1
		),
		snapshots as (
			select template_snapshot_id as id from owned_workspace
			union select b.snapshot_id from environment_build b join owned_workspace w on w.id=b.workspace_id
			union select snapshot_id from workspace_retention where user_id=$1
		)
		select
			(select array_agg(id order by id) from vms where id is not null and id<>'') as vm_ids,
			(select array_agg(s.id order by s.id) from snapshots s
				where s.id is not null and s.id<>''
				and not exists (select 1 from workspace o where o.user_id<>$1 and o.template_snapshot_id=s.id)
				and not exists (select 1 from workspace_retention o where o.user_id<>$1 and o.snapshot_id=s.id)
				and not exists (select 1 from product_setting p where trim(p.value)=s.id)
			) as snapshot_ids,
			(select array_agg(id::text order by id) from agent_session where user_id=$1) as session_ids`,
		[userId],
	);
	const row = result.rows[0];
	return {
		vmIds: row?.vm_ids ?? [],
		snapshotIds: row?.snapshot_ids ?? [],
		sessionIds: row?.session_ids ?? [],
	};
}

/**
 * Deletes the account row; every owned row cascades from it. Unsettled VM
 * usage holds are settled at their full reservation first, so deleting an
 * account can never turn running compute into free compute.
 */
export async function deleteAccountRecords(userId: string) {
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query(
			`update infrastructure_usage_reservation r set consumed_micro_usd=r.reserved_micro_usd, settled_at=now()
			from infrastructure_vm_admission a
			where a.reservation_id=r.id and a.user_id=$1 and r.consumed_micro_usd is null`,
			[userId],
		);
		const deleted = await client.query(
			"delete from auth_user where id=$1 returning id",
			[userId],
		);
		if (!deleted.rowCount)
			throw new Response("Account is not available.", { status: 404 });
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
