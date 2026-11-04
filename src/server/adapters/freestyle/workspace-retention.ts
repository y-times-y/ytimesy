import { randomUUID } from "node:crypto";
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
import { projectForOwner } from "../projects";
import { repositoryDirectory } from "../repository-setup";
import { productCreateVmFields } from "./product-vm";
import { scrubAgentSecrets } from "./scrub-agent-secrets";
import { sessionSlugMatch } from "./slug-sql";
import {
	admitVmCreate,
	infrastructureAdmissionEnabled,
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
		infrastructureAdmissionEnabled()
	);
}

/**
 * The retention touch as SQL common table expressions, so admission can run it
 * in the same round trip as its own reads. Parameters: $1 slug, $2 VM id,
 * $3 resources, $4 enroll (no row yet and created after the cutover), $5 touch
 * (retention applies to this VM). `prior` is the row before the touch, with
 * its chat's current VM (`session_vm`); the upsert only runs where
 * assertRetentionTouched would not refuse. An active row bound to another VM
 * is rebound only when this VM is the chat's current one: the chat's VM was
 * replaced without moving the row. A caller holding a VM the chat no longer
 * names (a stale caller racing a restore) is still refused.
 */
export const RETENTION_TOUCH_CTES = `retention_prior as (select r.phase,r.vm_id,
  (select s.provider_ref from agent_session s where s.id=r.session_id) as session_vm
  from workspace_retention r where $5::boolean and r.slug=$1),
 retention_touched as (insert into workspace_retention(session_id,user_id,vm_id,slug,resources)
  select id,user_id,$2,$1,$3::jsonb from agent_session where $5::boolean and ${sessionSlugMatch("$1")} and (agent_role is null or agent_role='writer')
  and coalesce((select phase='active' and (vm_id=$2 or session_vm=$2) from retention_prior),$4::boolean)
  on conflict(session_id) do update set last_activity_at=now(),vm_id=$2,resources=$3::jsonb where workspace_retention.phase='active' returning 1)`;

/** Parameters $1-$5 of RETENTION_TOUCH_CTES for this VM. */
export function retentionTouchParams(data: VmData) {
	const touch =
		workspaceRetentionEnabled() && !!data.slug?.startsWith("ytimesy-ag-");
	// A fixed deployment cutover protects pre-existing user machines from automatic deletion.
	const cutover = Date.parse(process.env.YTIMESY_RETENTION_ENROLL_AFTER ?? "");
	const created = Date.parse(data.createdAt);
	const enroll =
		Number.isFinite(cutover) && Number.isFinite(created) && created >= cutover;
	return [data.slug, data.id, JSON.stringify(data.resources), enroll, touch];
}

/**
 * Refuses a touch that found the workspace mid-recovery or bound to another
 * VM, unless this VM is the chat's current one (the touch rebound the row).
 */
export function assertRetentionTouched(
	prior: {
		phase: string | null;
		vmId: string | null;
		sessionVm: string | null;
	},
	data: VmData,
) {
	if (prior.phase === null) return;
	if (prior.phase !== "active")
		throw new Error("Workspace recovery is in progress. Retry shortly.");
	if (prior.vmId === data.id) return;
	if (prior.sessionVm !== data.id)
		throw new Error("Workspace recovery binding changed. Retry shortly.");
	console.warn("Rebound workspace retention to the chat's current VM.", {
		slug: data.slug,
		from: prior.vmId,
		to: data.id,
	});
}

/**
 * Moves an active retention row from a chat's lost VM to its replacement
 * before the replacement is first used, while the chat still names the lost
 * VM (or already names the replacement). A row mid-recovery or bound to any
 * other VM is left alone.
 */
export async function rebindWorkspaceRetention(
	sessionId: string,
	fromVmId: string,
	toVmId: string,
) {
	if (fromVmId === toVmId) return;
	await database().query(
		`update workspace_retention w set vm_id=$3,last_activity_at=now()
		 where w.session_id=$1 and w.phase='active' and w.vm_id=$2
		 and exists(select 1 from agent_session s where s.id=$1 and s.provider_ref in ($2,$3))`,
		[sessionId, fromVmId, toVmId],
	);
}

/** Runs under the same per-VM fence as every compute admission. Never enroll templates or operator VMs. */
export async function touchWorkspaceRetention(
	client: PoolClient,
	data: VmData,
) {
	const params = retentionTouchParams(data);
	if (!params[4]) return;
	const result = await client.query<{
		phase: string | null;
		vm_id: string | null;
		session_vm: string | null;
	}>(
		`with ${RETENTION_TOUCH_CTES} select (select phase from retention_prior) as phase,(select vm_id from retention_prior) as vm_id,(select session_vm from retention_prior) as session_vm`,
		params,
	);
	assertRetentionTouched(
		{
			phase: result.rows[0].phase,
			vmId: result.rows[0].vm_id,
			sessionVm: result.rows[0].session_vm,
		},
		data,
	);
}

/**
 * A recycle that stopped safely before retiring anything: the source VM is
 * kept, the row backs off (retry_after), and a later tick tries again. Not an
 * operational failure: nothing here needs a human.
 */
export class RecycleDeferred extends Error {
	override name = "RecycleDeferred";
	constructor(
		message: string,
		/** A short, stable reason for logs: what kept the source VM. */
		readonly category: RecycleDeferCategory = "other",
	) {
		super(message);
	}
}

export type RecycleDeferCategory =
	| "busy"
	| "activity"
	| "symlinked-root"
	| "special-file"
	| "size"
	| "unreadable"
	| "changed"
	| "timeout"
	| "digest-output"
	| "mismatch"
	| "other";

/** Wall clock for one in-guest tree digest. Both digests and the snapshot run inside one 90-second VM lease (usage-admission LEASE_SECONDS). */
export const TREE_DIGEST_TIMEOUT_MS = 20_000;
/** Bounds on what one digest may hash; past them the source VM is kept. */
const TREE_DIGEST_MAX_ENTRIES = 250_000;
const TREE_DIGEST_MAX_BYTES = 4 * 1024 ** 3;
/**
 * Runtime the fenced source may use to scrub secrets and hash its tree:
 * the scrub's 90 seconds (a stopped VM boots inside it), the digest's 20
 * and resume/pause slack. The provider cap enforces it; a hold of the same
 * length pays for it.
 */
const CAPTURE_WINDOW_SECONDS = 120;
/** The verification copy's runtime cap: boot plus one digest, under its 80-second hold. */
const VERIFICATION_RUN_SECONDS = 45;

const TREE_DIGEST_REFUSALS: Record<
	number,
	[message: string, category: RecycleDeferCategory]
> = {
	64: [
		"Recovery verification refuses a symlinked project root; preserve the source VM.",
		"symlinked-root",
	],
	65: [
		"Recovery verification encountered a special file; preserve the source VM.",
		"special-file",
	],
	66: [
		"Recovery verification exceeds its bounded file limit; preserve the source VM.",
		"size",
	],
	67: [
		"Recovery verification exceeds its content allowance; preserve the source VM.",
		"size",
	],
	68: [
		"Recovery verification could not read the project tree; preserve the source VM.",
		"unreadable",
	],
	69: [
		"Recovery file changed or became unreadable during verification; preserve the source VM.",
		"changed",
	],
};

/**
 * One shell command (POSIX sh, GNU find/coreutils) that hashes every entry
 * under the roots, ignored files included, into one sha256 over four sorted
 * sections: a manifest of type, mode, owner, group, size (files only) and
 * path; each file's content hash; the symlink paths; and, in the same order,
 * each link's target text (readlink, never followed). Links are covered
 * exactly without reading what they point to. A symlinked root is refused:
 * hashing it would cover only the link, not the project behind it. Fifos,
 * sockets and devices fail closed, checked before and after hashing.
 * Prints one bounded line.
 */
export function treeDigestCommand(roots: string[]) {
	if (!roots.length) throw new Error("Recovery verification has no roots.");
	for (const root of roots)
		if (
			!/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(root) ||
			/(^|\/)\.\.?(\/|$)/.test(root)
		)
			throw new Error("Invalid recovery file path.");
	const paths = [...roots]
		.sort()
		.map((root) => `'${root}'`)
		.join(" ");
	return [
		"export LC_ALL=C",
		"t=$(mktemp -d) || exit 70",
		"trap 'rm -rf \"$t\"' EXIT",
		`refuse() { for r in ${paths}; do [ -L "$r" ] && exit 64; done; find ${paths} ! -type f ! -type d ! -type l -print -quit >"$t/s" 2>/dev/null || exit 68; [ -s "$t/s" ] && exit 65; return 0; }`,
		"refuse",
		`find ${paths} -type f -printf 'f %m %u %g %s %p\\0' -o -printf '%y %m %u %g - %p\\0' >"$t/m0" 2>/dev/null || exit 68`,
		'sort -z "$t/m0" >"$t/m" || exit 70',
		`n=$(tr -cd '\\000' <"$t/m" | wc -c)`,
		`[ "$n" -le ${TREE_DIGEST_MAX_ENTRIES} ] || exit 66`,
		`b=$(find ${paths} -type f -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s}')`,
		`[ "$b" -le ${TREE_DIGEST_MAX_BYTES} ] || exit 67`,
		`find ${paths} -type f -print0 >"$t/f0" 2>/dev/null || exit 68`,
		'sort -z "$t/f0" >"$t/f" || exit 70',
		'xargs -0 -r sha256sum <"$t/f" >"$t/h" 2>/dev/null || exit 69',
		`find ${paths} -type l -print0 >"$t/l0" 2>/dev/null || exit 68`,
		'sort -z "$t/l0" >"$t/l" || exit 70',
		'xargs -0 -r readlink -z -- <"$t/l" >"$t/lt" 2>/dev/null || exit 69',
		"refuse",
		'd=$(for s in m h l lt; do sha256sum <"$t/$s" || exit 70; done | sha256sum) || exit 70',
		`printf 'ytimesy-tree-v2 %s %s %s\\n' "$n" "$b" "\${d%% *}"`,
	].join("\n");
}

/** Reads a tree digest command's result; anything unexpected keeps the source VM. */
export function parseTreeDigest(result: {
	statusCode?: number | null;
	stdout?: string | null;
}) {
	if (result.statusCode == null)
		throw new RecycleDeferred(
			"Recovery verification exceeded its time budget; preserve the source VM.",
			"timeout",
		);
	if (result.statusCode !== 0) {
		const [message, category] = TREE_DIGEST_REFUSALS[result.statusCode] ?? [
			`Recovery verification failed (exit ${result.statusCode}); preserve the source VM.`,
			"other",
		];
		throw new RecycleDeferred(message, category);
	}
	const match = /^ytimesy-tree-v2 (\d+) (\d+) ([0-9a-f]{64})\n?$/.exec(
		result.stdout ?? "",
	);
	if (!match)
		throw new RecycleDeferred(
			"Recovery verification returned no digest; preserve the source VM.",
			"digest-output",
		);
	return {
		digest: match[3],
		entries: Number(match[1]),
		bytes: Number(match[2]),
	};
}

/**
 * Hashes every entry in the project roots inside the guest with one command,
 * as root so no file is unreadable. Runs the VM: a paused VM resumes, and a
 * fenced one refuses (the caller opens a run window first).
 */
export async function retainedTreeDigest(
	vm: Pick<Vm, "exec">,
	roots: string[],
) {
	const result = await vm.exec({
		command: treeDigestCommand(roots),
		linuxUser: "root",
		timeoutMs: TREE_DIGEST_TIMEOUT_MS,
	});
	return parseTreeDigest(result).digest;
}

/**
 * Opens a short run window on the fenced, paused source to scrub secrets and
 * hash its tree in the guest, then pauses it and closes the fence at the
 * runtime it used. This is maintenance, not the user's work: it is bounded by
 * the provider cap (CAPTURE_WINDOW_SECONDS), never reserved against the
 * user's allowance, and the VM's own admission moves past it so a later wake
 * does not count it (two ledgers for one VM once locked a chat out).
 */
async function captureSourceTree(
	connection: PoolClient,
	row: Retention,
	vm: Vm,
	data: VmData,
	roots: string[],
) {
	const before = data.totalRunSeconds ?? 0;
	try {
		await vm.update({
			maxRunTotalSeconds: Math.floor(before) + CAPTURE_WINDOW_SECONDS,
			automaticRestart: false,
		});
		await scrubAgentSecrets(vm);
		return await retainedTreeDigest(vm, roots);
	} finally {
		if ((await vm.data()).state === "running") await vm.pause();
		const stopped = await vm.data();
		if (stopped.state === "paused" && stopped.totalRunSeconds != null) {
			await vm.update({
				maxRunTotalSeconds: Math.floor(stopped.totalRunSeconds),
				automaticRestart: false,
			});
			const ranSeconds = Math.max(
				0,
				Math.floor(stopped.totalRunSeconds) - Math.floor(before),
			);
			await connection.query(
				`update infrastructure_vm_admission
				 set baseline_seconds=baseline_seconds+$2, max_run_total_seconds=$3, updated_at=now()
				 where vm_id=$1`,
				[row.vm_id, ranSeconds, Math.floor(stopped.totalRunSeconds)],
			);
		}
	}
}

function isNotFound(error: unknown) {
	return error instanceof FreestyleApiError && error.status === 404;
}

/** True only when the provider itself answers 404 for this VM now. */
async function vmGone(vm: Vm) {
	try {
		await vm.data();
		return false;
	} catch (error) {
		return isNotFound(error);
	}
}

/** Clock skew allowed between this server and the provider's activity stamps. */
const ACTIVITY_SKEW_MS = 5_000;

/**
 * `fencedAt`: once the source is fenced, nothing but this recycle can run it,
 * so network activity stamped from then on is the capture window's own
 * resume (the provider reports it some seconds late). Earlier activity
 * within the idle period still defers.
 */
async function stillIdle(
	client: PoolClient,
	row: Retention,
	vm: Vm,
	fencedAt?: number,
) {
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
		throw new RecycleDeferred("Workspace is no longer safely idle.", "busy");
	const activity = Date.parse(data.lastNetworkActivity ?? data.createdAt);
	if (
		!Number.isFinite(activity) ||
		(Date.now() - activity < WORKSPACE_RECYCLE_IDLE_SECONDS * 1000 &&
			(fencedAt === undefined || activity < fencedAt - ACTIVITY_SKEW_MS))
	)
		throw new RecycleDeferred(
			"Workspace has recent interactive activity.",
			"activity",
		);
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
		try {
			const data = await stillIdle(connection, row, vm);
			const fencedAt = Date.now();
			await vm.update({
				maxRunTotalSeconds: Math.floor(data.totalRunSeconds ?? 0),
				automaticRestart: false,
			});
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
			const digest = await captureSourceTree(
				connection,
				row,
				vm,
				await stillIdle(connection, row, vm, fencedAt),
				roots,
			);
			const fenced = await stillIdle(connection, row, vm, fencedAt);
			if (fenced.maxRunTotalSeconds !== Math.floor(fenced.totalRunSeconds ?? 0))
				throw new Error("Provider did not confirm the recycling fence.");
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
			// Maintenance: bounded by VERIFICATION_RUN_SECONDS, not the user's allowance.
			const clone = await client.vms.create({
				snapshotId,
				firewall: { rules: [] },
				maxRunTotalSeconds: VERIFICATION_RUN_SECONDS,
				automaticRestart: false,
				autoDeleteSeconds: 300,
				metadata: { purpose: "ytimesy-retention-verification" },
			});
			verification = clone.vm;
			if ((await verification.data()).state === "starting")
				await waitUntilVmRunning(verification, "Recovery verification machine");
			// The copy resumes at the snapshot's instant, network denied, and is
			// hashed by the same command before anything else runs in it.
			const restored = await retainedTreeDigest(verification, roots);
			if ((await verification.data()).state === "running")
				await verification.pause();
			// Usually a process still writing in the project between the two
			// digests. The source VM and its row are kept either way; a later
			// tick retries.
			if (restored !== digest)
				throw new RecycleDeferred(
					"Independent recovery verification failed: the restored tree differs; preserve the source VM.",
					"mismatch",
				);
			await stillIdle(connection, row, vm, fencedAt);
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
		} catch (error) {
			if (!isNotFound(error)) throw error;
			// Deleted after its recovery was persisted: retired as intended.
			if (retained) return;
			// The source VM no longer exists (deleted elsewhere): nothing is left
			// to retain. Drop its row, like reconcile settles a deleted VM's hold.
			if (!(await vmGone(vm))) throw error;
			const removed = await connection.query(
				"delete from workspace_retention where session_id=$1 and vm_id=$2 and phase='capturing' returning session_id",
				[sessionId, row.vm_id],
			);
			if (snapshotId && removed.rowCount)
				await client.vms.snapshots.delete(snapshotId).catch(() => undefined);
			snapshotId = undefined;
			console.info(
				"Workspace VM already gone; its retention row was removed.",
				{
					sessionId,
				},
			);
		} finally {
			if (verification) {
				try {
					if ((await verification.data()).state === "running")
						await verification.pause();
					await verification.delete();
				} catch {
					/* The provider cap bounds a clone that could not be deleted here. */
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
	// One workspace per tick: each verification runs two in-guest digests of up to 20 seconds.
	for (const row of rows.rows)
		try {
			await recycleWorkspace(client, row.session_id);
		} catch (error) {
			if (!(error instanceof RecycleDeferred)) throw error;
			console.info("Workspace recycling deferred; the source VM is kept.", {
				sessionId: row.session_id,
				category: error.category,
				reason: error.message,
			});
		}
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
