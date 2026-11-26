import type { Freestyle } from "freestyle";
import type { OwnerAlert } from "#/domain/owner-alerts";
import {
	FREESTYLE_STORAGE_QUOTA_GIB,
	IDLE_WORKSPACE_DAYS,
	storageAlert,
	storageLevel,
	storageUsage,
} from "#/domain/storage-retention";
import { NOT_CANARY_CHAT } from "../canary-chat";
import { database } from "../database";
import { alertOwner } from "../owner-alerts";

const DAY_MS = 86_400_000;

type SweepVm = {
	id: string;
	state: string;
	resources: { storage: number };
	lastNetworkActivity?: string | null;
};

export type SweepDeps = {
	now: Date;
	quotaGiB: number;
	listVms: () => Promise<SweepVm[]>;
	snapshotCount: () => Promise<number>;
	/** VM ids of chats with no running or queued turn, not canary, idle and recoverable. */
	idleChatMachines: () => Promise<string[]>;
	/** VM ids of failed environment builds nothing refers to any more. */
	staleBuildMachines: () => Promise<string[]>;
	destroyVm: (id: string) => Promise<void>;
	markBuildReleased: (id: string) => Promise<void>;
	alert: (alert: OwnerAlert) => Promise<unknown>;
};

/**
 * Scheduled storage retention. Every step is independent and best effort: a
 * failing query, delete or alert never stops the others or fails the job
 * (bookkeeping never blocks the user). The database names what may go; the
 * provider's own last activity and state must agree before anything is deleted.
 */
export async function sweepStorage(deps: SweepDeps) {
	const cutoff = deps.now.getTime() - IDLE_WORKSPACE_DAYS * DAY_MS;
	let vms = await deps.listVms();
	const result = {
		deletedIdle: 0,
		deletedBuilds: 0,
		level: "ok" as ReturnType<typeof storageLevel>,
	};

	const remove = async (ids: string[], onlyIdle: boolean) => {
		let deleted = 0;
		for (const id of ids) {
			const vm = vms.find((candidate) => candidate.id === id);
			if (!vm || vm.state === "running") continue;
			const last = vm.lastNetworkActivity
				? new Date(vm.lastNetworkActivity).getTime()
				: 0;
			if (onlyIdle && last > cutoff) continue;
			try {
				await deps.destroyVm(id);
				if (!onlyIdle) await deps.markBuildReleased(id);
				deleted += 1;
				vms = vms.filter((candidate) => candidate.id !== id);
			} catch {
				console.warn(
					"Storage retention could not delete a machine; retried next run.",
				);
			}
		}
		return deleted;
	};

	try {
		result.deletedIdle = await remove(await deps.idleChatMachines(), true);
	} catch {
		console.warn("Storage retention: idle chat sweep failed.");
	}
	try {
		result.deletedBuilds = await remove(await deps.staleBuildMachines(), false);
	} catch {
		console.warn("Storage retention: stale build sweep failed.");
	}
	try {
		const usage = storageUsage(vms, await deps.snapshotCount(), deps.quotaGiB);
		result.level = storageLevel(usage.fraction);
		const alert = storageAlert(
			result.level,
			usage.usedGiB,
			usage.quotaGiB,
			deps.now,
		);
		if (alert) await deps.alert(alert);
	} catch {
		console.warn("Storage retention: usage alert failed.");
	}
	return result;
}

/**
 * Chat machines that may go: every chat bound to the VM is not canary, has no
 * running or queued turn, has not changed for the idle window, and is either
 * archived or has a workspace checkpoint newer than its last change that was
 * taken on this very machine (the recovery path). Template and build machines
 * are never named here.
 */
export async function idleChatMachineIds(days = IDLE_WORKSPACE_DAYS) {
	const result = await database().query<{ provider_ref: string }>(
		`select s.provider_ref from agent_session s
		 where s.provider_ref like 'vm-%'
		 group by s.provider_ref
		 having bool_and(${NOT_CANARY_CHAT})
		   and bool_and(s.turn_status not in ('running','queued') and s.status not in ('running','queued'))
		   and bool_and(s.updated_at < now() - make_interval(days => $1))
		   and bool_and(s.archived_at is not null or exists (select 1 from session_checkpoint c where c.session_id=s.id and c.executor_id=s.provider_ref and c.created_at >= s.updated_at))
		   and not exists (select 1 from workspace w where w.provider_ref=s.provider_ref)
		   and not exists (select 1 from environment_build b where b.provider_ref=s.provider_ref)
		   and not exists (select 1 from workspace_retention r where r.vm_id=s.provider_ref and r.phase<>'active')`,
		[days],
	);
	return result.rows.map((row) => row.provider_ref);
}

/** Failed environment builds older than a day whose machine is still held. */
export async function staleBuildMachineIds() {
	const result = await database().query<{ provider_ref: string }>(
		`select b.provider_ref from environment_build b
		 where b.status='failed' and b.provider_ref is not null and b.provider_released_at is null
		   and b.created_at < now() - interval '1 day'
		   and not exists (select 1 from workspace w where w.provider_ref=b.provider_ref)`,
	);
	return result.rows.map((row) => row.provider_ref);
}

export async function markBuildMachineReleased(vmId: string) {
	await database().query(
		"update environment_build set provider_released_at=now() where provider_ref=$1 and provider_released_at is null",
		[vmId],
	);
}

export function storageQuotaGiB(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const value = Number(env.YTIMESY_STORAGE_QUOTA_GIB);
	return value > 0 ? value : FREESTYLE_STORAGE_QUOTA_GIB;
}

export async function runStorageRetention(client: Freestyle) {
	return sweepStorage({
		now: new Date(),
		quotaGiB: storageQuotaGiB(),
		listVms: async () => {
			const vms: SweepVm[] = [];
			for (let offset = 0; offset < 10_000; offset += 100) {
				const page = await client.vms.list({ limit: 100, offset });
				vms.push(...page.vms);
				if (offset + page.vms.length >= page.totalCount || !page.vms.length)
					break;
			}
			return vms;
		},
		snapshotCount: async () =>
			(await client.vms.snapshots.list({ limit: 1 })).totalCount,
		idleChatMachines: () => idleChatMachineIds(),
		staleBuildMachines: staleBuildMachineIds,
		destroyVm: (id) =>
			client.vms
				.ref(id)
				.delete()
				.then(() => undefined),
		markBuildReleased: markBuildMachineReleased,
		alert: (alert) => alertOwner(alert),
	});
}
