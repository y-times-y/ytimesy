import { createHash, randomUUID } from "node:crypto";
import {
	type Freestyle,
	FreestyleApiError,
	type VmData,
	type VmResources,
} from "freestyle";
import type { PoolClient } from "pg";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { repositoriesForProject } from "#/domain/projects";
import {
	snapshotSupportsRetention,
	WORKSPACE_RECYCLE_IDLE_SECONDS,
	WORKSPACE_RETENTION_SECONDS,
} from "#/domain/workspace-retention";
import { database } from "../database";
import {
	reserveInfrastructureUsage,
	settleInfrastructureUsage,
} from "../infrastructure-usage";
import { projectForOwner } from "../projects";
import { repositoryDirectory } from "../repository-setup";
import { productCreateVmFields } from "./product-vm";
import { scrubAgentSecrets } from "./scrub-agent-secrets";
import {
	admitVmCreate,
	computeHourlyMicroUsd,
	lockedVm,
} from "./usage-admission";
import { waitUntilVmRunning } from "./wait-until-running";

type Vm = ReturnType<Freestyle["vms"]["ref"]>;
type Retention = {
	session_id: string;
	user_id: string;
	vm_id: string;
	slug: string;
	phase: "active" | "capturing" | "retained" | "restoring" | "expired";
	snapshot_id: string | null;
	resources: VmResources;
	expires_at: Date | null;
};
export function workspaceRetentionEnabled() {
	return (
		process.env.YTIMESY_WORKSPACE_RETENTION === "true" &&
		process.env.YTIMESY_INFRASTRUCTURE_ADMISSION === "true"
	);
}

/** Runs under the same per-VM fence as every compute admission. Never enroll templates or operator VMs. */
export async function touchWorkspaceRetention(
	client: PoolClient,
	data: VmData,
) {
	if (!workspaceRetentionEnabled() || !data.slug?.startsWith("ytimesy-ag-"))
		return;
	const prior = await client.query<Retention>(
		"select * from workspace_retention where slug=$1",
		[data.slug],
	);
	if (prior.rows[0] && prior.rows[0].phase !== "active")
		throw new Error("Workspace recovery is in progress. Retry shortly.");
	if (prior.rows[0] && prior.rows[0].vm_id !== data.id)
		throw new Error("Workspace recovery binding changed. Retry shortly.");
	// A fixed deployment cutover protects pre-existing user machines from automatic deletion.
	if (!prior.rows[0]) {
		const cutover = Date.parse(
			process.env.YTIMESY_RETENTION_ENROLL_AFTER ?? "",
		);
		const created = Date.parse(data.createdAt);
		if (
			!Number.isFinite(cutover) ||
			!Number.isFinite(created) ||
			created < cutover
		)
			return;
	}
	await client.query(
		`insert into workspace_retention(session_id,user_id,vm_id,slug,resources)
	 select id,user_id,$2,$1,$3 from agent_session where 'ytimesy-ag-' || left(replace(id::text,'-',''),16)=$1 and task_placement is distinct from 'shared'
	 on conflict(session_id) do update set last_activity_at=now(),vm_id=$2,resources=$3 where workspace_retention.phase='active'`,
		[data.slug, data.id, JSON.stringify(data.resources)],
	);
}

/** Hash every regular file in the project roots, including ignored files; fail closed on unsupported entries or limits. */
export async function retainedTreeDigest(vm: Vm, roots: string[]) {
	const digest = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	const deadline = Date.now() + 30_000;
	const walk = async (path: string): Promise<void> => {
		if (Date.now() > deadline)
			throw new Error(
				"Recovery verification exceeded its time budget; preserve the source VM.",
			);
		if (++entries > 10_000)
			throw new Error(
				"Recovery verification exceeds its bounded file limit; preserve the source VM.",
			);
		const stat = await vm.fs.stat(path);
		digest.update(
			JSON.stringify([
				path,
				stat.permissions,
				stat.owner,
				stat.group,
				stat.isFile,
				stat.isDirectory,
				stat.isSymlink,
				stat.isFile ? stat.size : null,
			]),
		);
		if (stat.isSymlink)
			throw new Error(
				"Recovery verification cannot independently verify symlinks; preserve the source VM.",
			);
		if (stat.isDirectory) {
			const children = await vm.fs.readDir(path);
			for (const entry of children.sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				if (
					!entry.name ||
					/[/\0]/.test(entry.name) ||
					[".", ".."].includes(entry.name)
				)
					throw new Error("Invalid recovery file path.");
				await walk(`${path}/${entry.name}`);
			}
		} else if (stat.isFile) {
			bytes += stat.size;
			if (
				!Number.isSafeInteger(stat.size) ||
				stat.size < 0 ||
				bytes > 32 * 1024 * 1024
			)
				throw new Error(
					"Recovery verification exceeds its transfer allowance; preserve the source VM.",
				);
			const content = await vm.fs.readFile(path);
			if (content.byteLength !== stat.size)
				throw new Error("Recovery file changed during verification.");
			digest.update(content);
		} else
			throw new Error(
				"Recovery verification encountered a special file; preserve the source VM.",
			);
	};
	for (const root of [...roots].sort()) await walk(root);
	return digest.digest("hex");
}

async function stillIdle(client: PoolClient, row: Retention, vm: Vm) {
	const active = await client.query(
		`select 1 from agent_session s where s.provider_ref=$1 and
	 (s.turn_status='running' or exists(select 1 from api_turn t where t.session_id=s.id and t.state in ('queued','running'))) limit 1`,
		[row.vm_id],
	);
	const data = await vm.data();
	if (
		active.rowCount ||
		data.id !== row.vm_id ||
		data.state !== "paused" ||
		data.totalRunSeconds == null
	)
		throw new Error("Workspace is no longer safely idle.");
	const activity = Date.parse(data.lastNetworkActivity ?? data.createdAt);
	if (
		!Number.isFinite(activity) ||
		Date.now() - activity < WORKSPACE_RECYCLE_IDLE_SECONDS * 1000
	)
		throw new Error("Workspace has recent interactive activity.");
	return data;
}

/** Retires only enrolled, settled, idle writer VMs. The native exhausted cap fences public wakeups before deletion. */
export async function recycleWorkspace(client: Freestyle, sessionId: string) {
	if (!workspaceRetentionEnabled()) return;
	const found = await database().query<Retention>(
		"select * from workspace_retention where session_id=$1",
		[sessionId],
	);
	const row = found.rows[0];
	if (row?.phase !== "active") return;
	const vm = client.vms.ref(row.vm_id);
	await lockedVm(row.slug, async (connection) => {
		const claimed = await connection.query(
			`update workspace_retention set phase='capturing',phase_updated_at=now() where session_id=$1 and vm_id=$2 and phase='active' and last_activity_at < now()-interval '1 hour' returning session_id`,
			[sessionId, row.vm_id],
		);
		if (!claimed.rowCount) return;
		let snapshotId: string | undefined;
		let verification: Vm | undefined;
		let retained = false;
		const verificationHold = randomUUID();
		try {
			const data = await stillIdle(connection, row, vm);
			await vm.update({
				maxRunTotalSeconds: Math.floor(data.totalRunSeconds ?? 0),
				automaticRestart: false,
			});
			const fenced = await stillIdle(connection, row, vm);
			if (fenced.maxRunTotalSeconds !== Math.floor(fenced.totalRunSeconds ?? 0))
				throw new Error("Provider did not confirm the recycling fence.");
			const binding = await connection.query<{ project_id: string }>(
				"select project_id from agent_session where id=$1 and user_id=$2",
				[sessionId, row.user_id],
			);
			if (!binding.rows[0]) throw new Error("Recovery session is unavailable.");
			const project = await projectForOwner(
				row.user_id,
				binding.rows[0].project_id,
			);
			if (!project) throw new Error("Recovery project is unavailable.");
			const roots = repositoriesForProject(project).map((repo) =>
				repositoryDirectory(repo.fullName),
			);
			const digest = await retainedTreeDigest(vm, roots);
			await scrubAgentSecrets(vm);
			const created = await vm.snapshot({
				slug: `ytimesy-recovery-${randomUUID()}`,
				autoDeleteSeconds: -1,
				ttlSeconds: -1,
			});
			snapshotId = created.snapshotId;
			const expiresAt = Date.now() + WORKSPACE_RETENTION_SECONDS * 1000;
			const snapshot = await client.vms.snapshots.get(snapshotId);
			if (snapshot.public) {
				await client.vms.snapshots.delete(snapshotId);
				snapshotId = undefined;
				throw new Error(
					"Provider returned a public recovery snapshot; it was removed.",
				);
			}
			if (
				!snapshotSupportsRetention({
					...snapshot,
					expectedSourceVmId: row.vm_id,
					expiresAt,
				})
			)
				throw new Error(
					"Private snapshot does not satisfy the recovery window.",
				);
			await reserveInfrastructureUsage(
				{
					id: verificationHold,
					userId: row.user_id,
					resourceKey: `recovery-verification:${snapshotId}`,
					amountMicroUsd: Math.ceil(
						(computeHourlyMicroUsd(data.resources) * 80) / 3600,
					),
				},
				connection,
			);
			const clone = await client.vms.create({
				snapshotId,
				firewall: { rules: [] },
				maxRunTotalSeconds: 20,
				automaticRestart: false,
				autoDeleteSeconds: 300,
				metadata: { purpose: "ytimesy-retention-verification" },
			});
			verification = clone.vm;
			if ((await verification.data()).state === "starting")
				await waitUntilVmRunning(verification, "Recovery verification machine");
			if ((await verification.data()).state === "running")
				await verification.pause();
			if (
				(await verification.data()).state !== "paused" ||
				(await retainedTreeDigest(verification, roots)) !== digest
			)
				throw new Error("Independent recovery verification failed.");
			await stillIdle(connection, row, vm);
			const persisted = await connection.query(
				`update workspace_retention set phase='retained',snapshot_id=$2,resources=$3,expires_at=$4,verified_at=now() where session_id=$1 and vm_id=$5 and phase='capturing' returning session_id`,
				[
					sessionId,
					snapshotId,
					JSON.stringify(data.resources),
					new Date(expiresAt),
					row.vm_id,
				],
			);
			if (!persisted.rowCount)
				throw new Error("Recovery binding changed before retirement.");
			retained = true;
			// Persist recoverability before deleting. Unknown deletion outcomes remain recoverable and cannot admit the old VM.
			await vm.delete();
			if (row.snapshot_id && row.snapshot_id !== snapshotId)
				await client.vms.snapshots
					.delete(row.snapshot_id)
					.catch(() => undefined);
		} finally {
			if (verification) {
				try {
					if ((await verification.data()).state === "running")
						await verification.pause();
					const stopped = await verification.data();
					await verification.delete();
					if (stopped.state === "paused" && stopped.totalRunSeconds != null)
						await settleInfrastructureUsage(
							{
								id: verificationHold,
								userId: row.user_id,
								consumedMicroUsd: Math.ceil(
									(computeHourlyMicroUsd(stopped.resources) *
										stopped.totalRunSeconds) /
										3600,
								),
							},
							connection,
						);
				} catch {
					/* Unknown provider outcomes keep the verification hold. */
				}
			}
			if (!retained) {
				const reset = await connection.query(
					"update workspace_retention set phase='active',retry_after=now()+interval '1 hour' where session_id=$1 and phase='capturing' returning session_id",
					[sessionId],
				);
				if (snapshotId && reset.rowCount)
					await client.vms.snapshots.delete(snapshotId).catch(() => undefined);
			}
		}
	});
}

/** Retained full state wins over repository-only recovery; an expired/missing owned snapshot never silently falls back. */
export async function restoreRetainedWorkspace(
	client: Freestyle,
	userId: string,
	sessionId: string,
	oldVmId: string,
) {
	if (!workspaceRetentionEnabled()) return null;
	const result = await database().query<Retention>(
		"select * from workspace_retention where session_id=$1 and user_id=$2 and vm_id=$3",
		[sessionId, userId, oldVmId],
	);
	const row = result.rows[0];
	if (!row || row.phase === "active") return null;
	if (row.phase === "capturing")
		throw new Error("Workspace snapshot is being verified. Retry shortly.");
	if (
		row.phase === "expired" ||
		!row.snapshot_id ||
		!row.expires_at ||
		row.expires_at.getTime() <= Date.now()
	)
		throw new Error(
			"Retained workspace expired; recovery requires explicit action.",
		);
	const snapshot = await client.vms.snapshots.get(row.snapshot_id);
	if (snapshot.public || snapshot.sourceVmId !== oldVmId)
		throw new Error("Retained workspace ownership could not be verified.");
	try {
		await client.vms.ref(oldVmId).data();
		await lockedVm(row.slug, async (connection) => {
			await connection.query(
				"update workspace_retention set phase='active',last_activity_at=now() where session_id=$1 and user_id=$2 and vm_id=$3 and phase='retained'",
				[sessionId, userId, oldVmId],
			);
		});
		return oldVmId;
	} catch (error) {
		if (!(error instanceof FreestyleApiError && error.status === 404))
			throw error;
	}
	const slug = agentSessionMachineSlug(sessionId);
	const existing = await client.vms.list({ slug, limit: 1 });
	let replacement = existing.vms[0];
	if (!replacement) {
		const id = await admitVmCreate(
			client,
			slug,
			row.snapshot_id,
			async (cap) => {
				const created = await client.vms.create({
					...productCreateVmFields({
						slug,
						snapshotId: row.snapshot_id as string,
					}),
					maxRunTotalSeconds: cap,
					automaticRestart: false,
				});
				return created.vmId;
			},
		);
		replacement = await client.vms.ref(id).data();
	}
	if (
		replacement.snapshotId !== row.snapshot_id ||
		["cpu", "memory", "storage"].some(
			(key) =>
				replacement.resources[key as keyof VmResources] !==
				row.resources[key as keyof VmResources],
		)
	)
		throw new Error("Recovery machine does not match the retained snapshot.");
	const restoredId = replacement.id;
	await lockedVm(row.slug, async (connection) => {
		await connection.query("begin");
		try {
			const updated = await connection.query(
				`update workspace_retention set phase='active',vm_id=$3,last_activity_at=now() where session_id=$1 and user_id=$2 and vm_id=$4 and phase in ('retained','restoring') returning session_id`,
				[sessionId, userId, restoredId, oldVmId],
			);
			if (!updated.rowCount)
				throw new Error(
					"Recovery binding changed; retry from current session state.",
				);
			const rebound = await connection.query(
				"update agent_session set provider_ref=$3 where id=$1 and user_id=$2 and provider_ref=$4 returning id",
				[sessionId, userId, restoredId, oldVmId],
			);
			if (!rebound.rowCount)
				throw new Error("Session binding changed during recovery.");
			await connection.query("commit");
		} catch (error) {
			await connection.query("rollback");
			throw error;
		}
	});
	return restoredId;
}

export async function recycleIdleWorkspaces(client: Freestyle) {
	if (!workspaceRetentionEnabled()) return;
	await expireRetainedWorkspace(client);
	const interrupted = await database().query<{
		slug: string;
		session_id: string;
	}>(
		"select slug,session_id from workspace_retention where phase='capturing' and phase_updated_at < now()-interval '15 minutes' limit 1",
	);
	for (const row of interrupted.rows)
		await lockedVm(row.slug, async (connection) => {
			await connection.query(
				"update workspace_retention set phase='active',phase_updated_at=now() where session_id=$1 and phase='capturing' and phase_updated_at < now()-interval '15 minutes'",
				[row.session_id],
			);
		});
	const rows = await database().query<{ session_id: string }>(
		"select session_id from workspace_retention where phase='active' and retry_after <= now() and last_activity_at < now()-interval '1 hour' order by last_activity_at limit 1",
	);
	for (const row of rows.rows) await recycleWorkspace(client, row.session_id);
}

/** Expire only application-owned recovery artifacts; conversation records and source machines are untouched. */
export async function expireRetainedWorkspace(client: Freestyle) {
	if (!workspaceRetentionEnabled()) return;
	const due = await database().query<Retention>(
		"select * from workspace_retention where phase in ('retained','expired') and expires_at <= now() and snapshot_id is not null and retry_after <= now() order by expires_at limit 1",
	);
	const row = due.rows[0];
	if (!row?.snapshot_id) return;
	await lockedVm(row.slug, async (connection) => {
		const claimed = await connection.query(
			"update workspace_retention set phase='expired',retry_after=now()+interval '1 hour' where session_id=$1 and vm_id=$2 and snapshot_id=$3 and phase in ('retained','expired') and expires_at <= now() returning session_id",
			[row.session_id, row.vm_id, row.snapshot_id],
		);
		if (!claimed.rowCount) return;
		try {
			const snapshot = await client.vms.snapshots.get(
				row.snapshot_id as string,
			);
			if (snapshot.public || snapshot.sourceVmId !== row.vm_id)
				throw new Error("Expired snapshot ownership could not be verified.");
			await client.vms.snapshots.delete(row.snapshot_id as string);
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				throw error;
		}
		await connection.query(
			"update workspace_retention set snapshot_id=null where session_id=$1 and phase='expired' and snapshot_id=$2",
			[row.session_id, row.snapshot_id],
		);
	});
}
