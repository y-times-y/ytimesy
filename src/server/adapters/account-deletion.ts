import { database } from "./database";

/**
 * Provider resources an account owns, collected before its rows are deleted:
 * chat, template, build and retained-recovery VMs, the private snapshots
 * of its projects, and its memory repo. Snapshots another account still references are left alone.
 */
export async function accountCleanupTargets(userId: string) {
	const result = await database().query<{
		vm_ids: string[] | null;
		snapshot_ids: string[] | null;
		session_ids: string[] | null;
		memory_repo: string | null;
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
			(select array_agg(id::text order by id) from agent_session where user_id=$1) as session_ids,
			(select repo from user_memory where user_id=$1) as memory_repo`,
		[userId],
	);
	const row = result.rows[0];
	return {
		vmIds: row?.vm_ids ?? [],
		snapshotIds: row?.snapshot_ids ?? [],
		sessionIds: row?.session_ids ?? [],
		/** A memory repo name other than the default memory-<user> (evaluations). */
		memoryRepo: row?.memory_repo ?? null,
	};
}

/**
 * Deletes the account row; every owned row cascades from it, and an enabled
 * training consent is recorded as withdrawn. Unsettled VM
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
		// Deleting the account withdraws training consent; the audit event outlives it.
		await client.query(
			`insert into training_consent_event(user_id,enabled,policy_version,source)
			 select user_id,false,policy_version,'account-deletion' from training_consent where user_id=$1 and enabled`,
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

/**
 * Provider resources one project owns, collected before its rows are deleted:
 * chat, template, build and retained-recovery VMs, the project's private
 * snapshots, and its chat ids (for stored checkpoints and attachments).
 * Snapshots any other project or setting still references are left alone.
 */
export async function projectCleanupTargets(userId: string, projectId: string) {
	const result = await database().query<{
		vm_ids: string[] | null;
		snapshot_ids: string[] | null;
		session_ids: string[] | null;
	}>(
		`with owned_workspace as (select id, provider_ref, template_snapshot_id from workspace where user_id=$1 and project_id=$2),
		owned_session as (select id, provider_ref from agent_session where user_id=$1 and project_id=$2),
		vms as (
			select provider_ref as id from owned_session
			union select provider_ref from owned_workspace
			union select b.provider_ref from environment_build b join owned_workspace w on w.id=b.workspace_id
			union select r.vm_id from workspace_retention r join owned_session s on s.id=r.session_id
			union select a.vm_id from infrastructure_vm_admission a join owned_session s on a.slug='ytimesy-ag-'||left(replace(s.id::text,'-',''),16)
		),
		snapshots as (
			select template_snapshot_id as id from owned_workspace
			union select b.snapshot_id from environment_build b join owned_workspace w on w.id=b.workspace_id
			union select r.snapshot_id from workspace_retention r join owned_session s on s.id=r.session_id
		)
		select
			(select array_agg(id order by id) from vms where id is not null and id<>'') as vm_ids,
			(select array_agg(s.id order by s.id) from snapshots s
				where s.id is not null and s.id<>''
				and not exists (select 1 from workspace o where o.project_id<>$2 and o.template_snapshot_id=s.id)
				and not exists (select 1 from environment_build b join workspace o on o.id=b.workspace_id where o.project_id<>$2 and b.snapshot_id=s.id)
				and not exists (select 1 from workspace_retention o join agent_session a on a.id=o.session_id where a.project_id<>$2 and o.snapshot_id=s.id)
				and not exists (select 1 from product_setting p where trim(p.value)=s.id)
			) as snapshot_ids,
			(select array_agg(id::text order by id) from owned_session) as session_ids`,
		[userId, projectId],
	);
	const row = result.rows[0];
	return {
		vmIds: row?.vm_ids ?? [],
		snapshotIds: row?.snapshot_ids ?? [],
		sessionIds: row?.session_ids ?? [],
	};
}

/**
 * Retained-recovery VMs and snapshots of the chats being deleted (a chat and
 * its subagents), collected before their rows cascade away. A VM or snapshot
 * that anything outside these chats still references is left alone.
 */
export async function chatCleanupTargets(
	userId: string,
	sessionIds: readonly string[],
) {
	const result = await database().query<{
		vm_ids: string[] | null;
		snapshot_ids: string[] | null;
	}>(
		`with retained as (select vm_id,snapshot_id from workspace_retention where user_id=$1 and session_id=any($2::uuid[]))
		select
			(select array_agg(distinct r.vm_id order by r.vm_id) from retained r
				where r.vm_id<>''
				and not exists (select 1 from agent_session a where a.provider_ref=r.vm_id and not a.id=any($2::uuid[]))
				and not exists (select 1 from workspace w where w.provider_ref=r.vm_id)
				and not exists (select 1 from environment_build b where b.provider_ref=r.vm_id)
			) as vm_ids,
			(select array_agg(distinct r.snapshot_id order by r.snapshot_id) from retained r
				where r.snapshot_id is not null and r.snapshot_id<>''
				and not exists (select 1 from workspace_retention o where o.snapshot_id=r.snapshot_id and not o.session_id=any($2::uuid[]))
				and not exists (select 1 from workspace w where w.template_snapshot_id=r.snapshot_id)
				and not exists (select 1 from environment_build b where b.snapshot_id=r.snapshot_id)
				and not exists (select 1 from product_setting p where trim(p.value)=r.snapshot_id)
			) as snapshot_ids`,
		[userId, sessionIds],
	);
	const row = result.rows[0];
	return { vmIds: row?.vm_ids ?? [], snapshotIds: row?.snapshot_ids ?? [] };
}
