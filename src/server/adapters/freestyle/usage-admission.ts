import { randomUUID } from "node:crypto";
import {
	type Freestyle,
	FreestyleApiError,
	type VmData,
	type VmResources,
} from "freestyle";
import type { PoolClient } from "pg";
import { MachineUsageLimitReached } from "#/domain/api-turn-failure";
import { effectiveMachineResources } from "#/domain/machine-size";
import { database } from "../database";
import {
	reserveInfrastructureUsage,
	settleInfrastructureUsage,
	userInfrastructureUsage,
} from "../infrastructure-usage";
import {
	touchWorkspaceRetention,
	workspaceRetentionEnabled,
} from "./workspace-retention";

type Vm = ReturnType<Freestyle["vms"]["ref"]>;
type Admission = {
	vm_id: string | null;
	user_id: string;
	reservation_id: string;
	max_run_total_seconds: string;
	baseline_seconds: string;
	hourly_micro_usd: string;
	updated_at: Date | string;
};
const PROVIDER_STOP_BUFFER_SECONDS = 60;

export function infrastructureAdmissionEnabled() {
	return process.env.YTIMESY_INFRASTRUCTURE_ADMISSION === "true";
}

export function computeHourlyMicroUsd(resources: VmResources) {
	if (
		![resources.cpu, resources.memory].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	)
		throw new Error("Unknown VM resources.");
	return Math.ceil(resources.cpu * 40_320 + (resources.memory / 1024) * 12_900);
}

async function ownerForSlug(slug: string, client: PoolClient) {
	const result = await client.query<{ user_id: string }>(
		`select user_id from workspace where 'ytimesy-ws-' || id::text=$1
		 union all select user_id from agent_session where 'ytimesy-ag-' || left(replace(id::text,'-',''),16)=$1
		 union all select w.user_id from environment_build b join workspace w on w.id=b.workspace_id where 'ytimesy-build-' || b.id::text=$1`,
		[slug],
	);
	if (result.rows.length !== 1)
		throw new Error("VM usage owner could not be uniquely verified.");
	return result.rows[0].user_id;
}

/**
 * What a start or resume must do about a VM's lifetime runtime cap before the
 * provider is asked to run it. Freestyle answers any start of a VM whose
 * totalRunSeconds reached maxRunTotalSeconds with a 409, so a cap without
 * enough headroom must be extended (metered) or refused clearly (unmetered:
 * this deployment cannot charge for more runtime, so it must not raise it).
 * A settled (paused/stopped) VM needs room for the whole operation; a
 * running one is topped up separately as it runs.
 */
export function resumeCapDecision(input: {
	metered: boolean;
	settled: boolean;
	totalRunSeconds: number;
	capSeconds: number | null | undefined;
	requiredSeconds: number;
}): "keep" | "extend" | "spent" {
	const { capSeconds, totalRunSeconds } = input;
	if (capSeconds == null || capSeconds < 0)
		return input.metered ? "extend" : "keep";
	const headroom = input.settled ? input.requiredSeconds + 15 : 0;
	if (capSeconds - totalRunSeconds > headroom) return "keep";
	if (input.metered) return "extend";
	return totalRunSeconds >= capSeconds ? "spent" : "keep";
}

const LEASE_SECONDS = 90;
const LEASE_WAIT_MS = 20_000;

/**
 * Serializes admission per VM with an expiring lease row, not a session lock:
 * an edge invocation can die before unlocking, and a lease then simply expires.
 * Operations hold it only for a few provider reads/updates, well under the lease.
 * Fleet locks never span network calls.
 */
export async function lockedVm<T>(
	slug: string,
	operation: (client: PoolClient) => Promise<T>,
	options: { waitMs?: number; pollMs?: number } = {},
) {
	const client = await database().connect();
	const holder = randomUUID();
	let leased = false;
	let destroy = false;
	try {
		const deadline = Date.now() + (options.waitMs ?? LEASE_WAIT_MS);
		while (!leased) {
			const acquired = await client.query(
				`insert into infrastructure_vm_lease(slug,holder,expires_at)
				 values($1,$2,now()+make_interval(secs=>$3))
				 on conflict(slug) do update set holder=excluded.holder, expires_at=excluded.expires_at
				 where infrastructure_vm_lease.expires_at < now()
				 returning holder`,
				[slug, holder, LEASE_SECONDS],
			);
			leased = acquired.rows.length > 0;
			if (leased) break;
			if (Date.now() >= deadline)
				throw new Error(
					"Another operation is updating this machine's usage. Try again shortly.",
				);
			await new Promise((resolve) =>
				setTimeout(resolve, options.pollMs ?? 250),
			);
		}
		return await operation(client);
	} finally {
		try {
			if (leased)
				await client.query(
					"delete from infrastructure_vm_lease where slug=$1 and holder=$2",
					[slug, holder],
				);
		} catch {
			destroy = true;
		} finally {
			client.release(destroy);
		}
	}
}

async function admittedCap(
	slug: string,
	resources: VmResources,
	totalSeconds: number,
	client: PoolClient,
	vmId?: string,
	requestedSeconds = 300,
	settled = false,
) {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0)
		throw new Error("VM runtime counter is unavailable.");
	const userId = await ownerForSlug(slug, client);
	const existing = await client.query<Admission>(
		"select * from infrastructure_vm_admission where slug=$1",
		[slug],
	);
	const previous = existing.rows[0];
	if (previous) {
		if (previous.vm_id && previous.vm_id !== vmId)
			throw new Error(
				"Workspace generation changed; the previous usage hold must be reconciled before recovery.",
			);
		if (previous.user_id !== userId)
			throw new Error("VM usage ownership changed.");
		if (Number(previous.hourly_micro_usd) !== computeHourlyMicroUsd(resources))
			throw new Error(
				"VM resources changed; its budget must be reconciled before resuming.",
			);
		if (
			resumeCapDecision({
				metered: true,
				settled,
				totalRunSeconds: totalSeconds,
				capSeconds: Number(previous.max_run_total_seconds),
				// requestedSeconds is the operation's need plus its margin.
				requiredSeconds: Math.max(0, requestedSeconds - 15),
			}) === "keep"
		)
			return Number(previous.max_run_total_seconds);
		const consumed = Math.ceil(
			((totalSeconds - Number(previous.baseline_seconds)) *
				Number(previous.hourly_micro_usd)) /
				3600,
		);
		await settleInfrastructureUsage(
			{
				id: previous.reservation_id,
				userId,
				consumedMicroUsd: consumed,
			},
			client,
		);
	}
	const hourlyMicroUsd = computeHourlyMicroUsd(resources);
	const balance = await userInfrastructureUsage(userId, client);
	const seconds = Math.min(
		Math.max(1, Math.min(3600, requestedSeconds)),
		Math.floor((balance.remainingMicroUsd * 3600) / hourlyMicroUsd) -
			PROVIDER_STOP_BUFFER_SECONDS,
	);
	if (seconds < 1) throw new MachineUsageLimitReached();
	const id = randomUUID();
	const baseline = Math.floor(totalSeconds);
	await reserveInfrastructureUsage(
		{
			id,
			userId,
			resourceKey: `vm:${slug}`,
			amountMicroUsd: Math.ceil(
				((seconds + PROVIDER_STOP_BUFFER_SECONDS) * hourlyMicroUsd) / 3600,
			),
		},
		client,
	);
	// Persist BEFORE provider mutation. A failed create/update retains its hold and retries the same absolute cap.
	await client.query(
		`insert into infrastructure_vm_admission(slug,user_id,reservation_id,max_run_total_seconds,baseline_seconds,hourly_micro_usd)
	 values($1,$2,$3,$4,$5,$6) on conflict(slug) do update set reservation_id=$3,max_run_total_seconds=$4,baseline_seconds=$5,hourly_micro_usd=$6,updated_at=now()`,
		[slug, userId, id, baseline + seconds, baseline, hourlyMicroUsd],
	);
	if (vmId)
		await client.query(
			"update infrastructure_vm_admission set vm_id=$2 where slug=$1 and (vm_id is null or vm_id=$2)",
			[slug, vmId],
		);
	return baseline + seconds;
}

export async function admitVmResume(
	vm: Vm,
	data: VmData,
	requiredSeconds = 60,
) {
	if (!infrastructureAdmissionEnabled()) {
		// Starting a spent VM only earns the provider's 409; say why instead.
		if (
			data.totalRunSeconds != null &&
			resumeCapDecision({
				metered: false,
				settled: settledState(data.state),
				totalRunSeconds: data.totalRunSeconds,
				capSeconds: data.maxRunTotalSeconds,
				requiredSeconds,
			}) === "spent"
		) {
			console.warn(
				"VM runtime budget is spent and usage admission is disabled here; set YTIMESY_INFRASTRUCTURE_ADMISSION to extend it.",
			);
			throw new Error(
				"The machine's runtime budget is used up and this deployment cannot extend it.",
			);
		}
		return;
	}
	if (!data.slug) throw new Error("VM usage identity is missing.");
	// Settle a stopped VM like a paused one, so its next cap is bought from
	// its real runtime instead of starting against a spent cap.
	if (settledState(data.state)) await reconcilePausedVm(vm);
	await lockedVm(data.slug, async (client) => {
		const latest = await vm.data();
		await touchWorkspaceRetention(client, latest);
		if (latest.totalRunSeconds == null)
			throw new Error("VM runtime counter is unavailable.");
		let cap = await admittedCap(
			data.slug as string,
			latest.resources,
			latest.totalRunSeconds,
			client,
			latest.id,
			Math.max(300, requiredSeconds + 15),
			settledState(latest.state),
		);
		if (
			settledState(latest.state) &&
			cap - latest.totalRunSeconds < requiredSeconds + 15
		)
			throw new MachineUsageLimitReached();
		let runningUsage: number | undefined;
		if (latest.state === "running") {
			const result = await client.query<Admission>(
				"select * from infrastructure_vm_admission where slug=$1",
				[data.slug],
			);
			const row = result.rows[0];
			const elapsed = Math.max(
				0,
				Math.ceil((Date.now() - new Date(row.updated_at).getTime()) / 1000),
			);
			runningUsage = Number(row.baseline_seconds) + elapsed;
			const needed = runningUsage + requiredSeconds + 15;
			if (needed > cap) {
				const target = Math.max(cap + 300, needed);
				await reserveInfrastructureUsage(
					{
						id: row.reservation_id,
						userId: row.user_id,
						resourceKey: `vm:${data.slug}`,
						amountMicroUsd: Math.ceil(
							((target -
								Number(row.baseline_seconds) +
								PROVIDER_STOP_BUFFER_SECONDS) *
								Number(row.hourly_micro_usd)) /
								3600,
						),
					},
					client,
					"increase",
				);
				await client.query(
					"update infrastructure_vm_admission set max_run_total_seconds=$2 where slug=$1",
					[data.slug, target],
				);
				cap = target;
			}
		}
		if (
			latest.maxRunTotalSeconds !== cap ||
			latest.automaticRestart !== false
		) {
			await vm.update({ maxRunTotalSeconds: cap, automaticRestart: false });
			const confirmed = await vm.data();
			if (confirmed.maxRunTotalSeconds !== cap)
				throw new Error("Provider did not confirm the execution budget.");
		}
		await client.query(
			"update infrastructure_vm_admission set vm_id=$2 where slug=$1 and (vm_id is null or vm_id=$2)",
			[data.slug, latest.id],
		);
		if (runningUsage !== undefined)
			recentAdmissions.set(latest.id, {
				cap,
				usedSeconds: runningUsage,
				at: Date.now(),
			});
	});
}

/** A full admission of a running VM is reused for this long by later guest operations. */
const ADMISSION_REUSE_MS = 60_000;
const recentAdmissions = new Map<
	string,
	{ cap: number; usedSeconds: number; at: number }
>();

/**
 * True when a full admission of this running VM in the last minute already
 * covers an operation needing requiredSeconds: re-running it would find the
 * same cap, extend nothing and only repeat its reads. The runtime estimate
 * grows by wall time since that admission (as admission's own estimate does),
 * and the provider must still report the same cap, no automatic restart and a
 * running machine; anything else takes the full path.
 */
export function recentAdmissionCovers(
	data: Pick<
		VmData,
		| "id"
		| "state"
		| "maxRunTotalSeconds"
		| "automaticRestart"
		| "totalRunSeconds"
	>,
	requiredSeconds: number,
	now = Date.now(),
) {
	if (!infrastructureAdmissionEnabled()) return false;
	const admitted = recentAdmissions.get(data.id);
	if (!admitted) return false;
	if (now - admitted.at > ADMISSION_REUSE_MS || now < admitted.at) {
		recentAdmissions.delete(data.id);
		return false;
	}
	if (
		data.state !== "running" ||
		data.maxRunTotalSeconds !== admitted.cap ||
		data.automaticRestart !== false
	)
		return false;
	const used = Math.max(
		admitted.usedSeconds + Math.ceil((now - admitted.at) / 1000),
		data.totalRunSeconds ?? Number.POSITIVE_INFINITY,
	);
	return used + requiredSeconds + 15 <= admitted.cap;
}

/** Test seam and recovery hook: the next operation on this VM runs full admission. */
export function forgetRecentAdmission(vmId?: string) {
	if (vmId === undefined) recentAdmissions.clear();
	else recentAdmissions.delete(vmId);
}

export async function admitVmCreate(
	client: Freestyle,
	slug: string,
	snapshotId: string,
	create: (cap?: number) => Promise<string>,
	requestedSeconds = 300,
	requestedResources?: VmResources,
) {
	if (!infrastructureAdmissionEnabled()) return create();
	const cap = await lockedVm(slug, async (connection) => {
		const prior = await connection.query<Admission>(
			"select * from infrastructure_vm_admission where slug=$1",
			[slug],
		);
		if (prior.rows[0]?.vm_id) {
			try {
				await client.vms.ref(prior.rows[0].vm_id).data();
				throw new Error(
					"Workspace generation changed; the previous VM still exists.",
				);
			} catch (error) {
				if (!(error instanceof FreestyleApiError && error.status === 404))
					throw error;
				// Its uncertain historical hold survives. A replacement must buy a separate runtime cap.
				await connection.query(
					"delete from infrastructure_vm_admission where slug=$1",
					[slug],
				);
			}
		}
		let resources: VmResources;
		if (snapshotId === "freestyle/ubuntu-sm")
			resources = { cpu: 2, memory: 4096, storage: 16384 };
		else {
			const snapshot = await client.vms.snapshots.get(snapshotId);
			if (!snapshot.sourceVmId)
				throw new Error(
					"Snapshot resources cannot be verified before spending.",
				);
			try {
				resources = (await client.vms.ref(snapshot.sourceVmId).data())
					.resources;
			} catch (error) {
				if (
					!(error instanceof FreestyleApiError && error.status === 404) ||
					!workspaceRetentionEnabled()
				)
					throw error;
				const retained = await connection.query<{ resources: VmResources }>(
					"select resources from workspace_retention where slug=$1 and snapshot_id=$2 and vm_id=$3 and phase in ('retained','restoring') and verified_at is not null and expires_at > now()",
					[slug, snapshotId, snapshot.sourceVmId],
				);
				if (snapshot.public || !retained.rows[0])
					throw new Error(
						"Owned snapshot resources cannot be verified before spending.",
					);
				resources = retained.rows[0].resources;
			}
		}
		return admittedCap(
			slug,
			requestedResources
				? effectiveMachineResources(resources, requestedResources)
				: resources,
			0,
			connection,
			undefined,
			requestedSeconds,
		);
	});
	const vmId = await create(cap);
	await database().query(
		"update infrastructure_vm_admission set vm_id=$2 where slug=$1 and vm_id is null",
		[slug, vmId],
	);
	return vmId;
}

/** Revoke future prepaid execution before refunding unused runtime. An uncertain provider response retains its hold. */
export async function reconcilePausedVm(vm: Vm) {
	if (!infrastructureAdmissionEnabled()) return;
	const data = await vm.data();
	if (!data.slug || !settledState(data.state) || data.totalRunSeconds == null)
		return;
	await lockedVm(data.slug, async (client) => {
		const result = await client.query<Admission>(
			"select * from infrastructure_vm_admission where slug=$1",
			[data.slug],
		);
		const row = result.rows[0];
		if (!row || row.vm_id !== data.id) return;
		const current = await vm.data();
		if (!settledState(current.state) || current.totalRunSeconds == null) return;
		const cap = Math.floor(current.totalRunSeconds);
		await vm.update({ maxRunTotalSeconds: cap, automaticRestart: false });
		const confirmed = await vm.data();
		if (
			!settledState(confirmed.state) ||
			confirmed.maxRunTotalSeconds !== cap ||
			confirmed.totalRunSeconds !== current.totalRunSeconds
		)
			throw new Error("Paused usage reconciliation could not be confirmed.");
		const consumed = Math.ceil(
			((current.totalRunSeconds - Number(row.baseline_seconds)) *
				Number(row.hourly_micro_usd)) /
				3600,
		);
		await client.query(
			"update infrastructure_vm_admission set max_run_total_seconds=$2 where slug=$1",
			[data.slug, cap],
		);
		await settleInfrastructureUsage(
			{
				id: row.reservation_id,
				userId: row.user_id,
				consumedMicroUsd: consumed,
			},
			client,
		);
	});
}

/** A paused or stopped VM accrues no runtime, so its hold can be settled. */
function settledState(state: string | null | undefined) {
	return state === "paused" || state === "stopped";
}

/**
 * A VM deleted before its hold was settled (normal deletion pauses, and so
 * settles, first) has no runtime left to read: its prepaid hold becomes usage,
 * so deleting a VM can never turn into free compute.
 */
async function settleDeletedVm(vmId: string) {
	const row = (
		await database().query<{
			reservation_id: string;
			user_id: string;
			reserved_micro_usd: string;
		}>(
			`select a.reservation_id,a.user_id,r.reserved_micro_usd from infrastructure_vm_admission a
			 join infrastructure_usage_reservation r on r.id=a.reservation_id
			 where a.vm_id=$1 and r.consumed_micro_usd is null`,
			[vmId],
		)
	).rows[0];
	if (!row) return;
	await settleInfrastructureUsage({
		id: row.reservation_id,
		userId: row.user_id,
		consumedMicroUsd: Number(row.reserved_micro_usd),
	});
}

export async function reconcileInfrastructureVms(client: Freestyle) {
	if (!infrastructureAdmissionEnabled()) return;
	const result = await database().query<{ vm_id: string }>(
		`select a.vm_id from infrastructure_vm_admission a join infrastructure_usage_reservation r on r.id=a.reservation_id where a.vm_id is not null and r.consumed_micro_usd is null order by a.updated_at limit 20`,
	);
	for (const row of result.rows) {
		try {
			const vm = client.vms.ref(row.vm_id);
			const data = await vm.data();
			if (
				data.state === "running" &&
				data.lastNetworkActivity &&
				Date.now() - new Date(data.lastNetworkActivity).getTime() < 60_000
			)
				await admitVmResume(vm, data, 120);
			else await reconcilePausedVm(vm);
		} catch (error) {
			if (error instanceof FreestyleApiError && error.status === 404) {
				await settleDeletedVm(row.vm_id).catch(() =>
					console.warn("Deleted VM usage could not be settled yet."),
				);
				continue;
			}
			console.warn(
				"VM usage reconciliation deferred; its reservation remains protected.",
			);
		}
	}
}
