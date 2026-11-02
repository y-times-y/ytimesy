import { ENVIRONMENT_BUILD_TIMEOUT_SECONDS } from "#/domain/environment-build-limits";
import { toolsSnapshotIdFromEnv } from "#/domain/workspace-boot-snapshot";
import { database } from "../adapters/database";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { readToolsSnapshotId } from "../records/tools-snapshot-store";

/**
 * A project's first environment build needs a machine booted from the tools
 * image before anything else. Adding the project starts that machine at once
 * (startEnvironmentMachineEarly), so it boots while the add request finishes
 * and the build is dispatched; the build then takes it instead of booting its
 * own (takeEarlyEnvironmentMachine).
 *
 * The machine is named after the workspace, which also makes the workspace's
 * owner its owner for usage admission (OWNERS_SQL). It is the same machine a
 * build would boot: the tools image, the build's runtime cap. Once a build
 * took it, its build row names it and it is released like any build machine;
 * one never taken is removed with its project (projectCleanupTargets), its
 * account (accountCleanupTargets), or when setup cannot start
 * (releaseUntakenEnvironmentMachine). Unused, it pauses after the product
 * idle timeout like every machine.
 */
export function earlyMachineSlug(workspaceId: string) {
	return `ytimesy-ws-${workspaceId}`;
}

/** Off with YTIMESY_ENVIRONMENT_EARLY_MACHINE=false. */
export function earlyEnvironmentMachineEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env.YTIMESY_ENVIRONMENT_EARLY_MACHINE !== "false";
}

async function toolsSnapshotId() {
	return toolsSnapshotIdFromEnv(process.env) || (await readToolsSnapshotId());
}

/** Boots the first build's machine now; idempotent by its slug. */
export async function startEnvironmentMachineEarly(
	workspaceId: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	if (!earlyEnvironmentMachineEnabled()) return null;
	const snapshotId = await toolsSnapshotId();
	return runtime.provision(earlyMachineSlug(workspaceId), {
		...(snapshotId ? { snapshotId } : {}),
		maxRunSeconds: ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
	});
}

/** Whether a build, the workspace or a chat already uses this machine. */
async function machineTaken(providerRef: string) {
	const result = await database().query<{ taken: boolean }>(
		`select exists(select 1 from environment_build where provider_ref=$1)
		  or exists(select 1 from workspace where provider_ref=$1)
		  or exists(select 1 from agent_session where provider_ref=$1) as taken`,
		[providerRef],
	);
	return result.rows[0]?.taken === true;
}

/** An early start whose create is still in flight: admitted, no machine id yet. */
async function earlyStartInFlight(slug: string) {
	const result = await database()
		.query<{ pending: boolean }>(
			`select exists(select 1 from infrastructure_vm_admission
			  where slug=$1 and vm_id is null and updated_at > now() - interval '60 seconds') as pending`,
			[slug],
		)
		.catch(() => ({ rows: [] as { pending: boolean }[] }));
	return result.rows[0]?.pending === true;
}

/**
 * The machine a project's first build runs on: the one adding the project
 * started (waiting a little for one still booting), or, when none was
 * started, one booted now under the same name. Null when this build must
 * boot its own: an incremental build, a build from another image, a
 * workspace that already has an environment, or a machine some earlier build
 * already used (it never runs a second build).
 */
export async function takeEarlyEnvironmentMachine(
	input: {
		readonly workspaceId: string;
		readonly baseSnapshotId: string | null;
		readonly incremental?: unknown;
	},
	hasEnvironment: boolean,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
	wait: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
	if (!earlyEnvironmentMachineEnabled() || input.incremental || hasEnvironment)
		return null;
	if ((await toolsSnapshotId()) !== input.baseSnapshotId) return null;
	const slug = earlyMachineSlug(input.workspaceId);
	let existing = await runtime.findBySlug(slug);
	for (let waited = 0; !existing && waited < 15_000; waited += 300) {
		if (!(await earlyStartInFlight(slug))) break;
		await wait(300);
		existing = await runtime.findBySlug(slug);
	}
	if (existing && (await machineTaken(existing))) return null;
	const vm = await runtime.provision(slug, {
		...(input.baseSnapshotId ? { snapshotId: input.baseSnapshotId } : {}),
		maxRunSeconds: ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
	});
	return (await machineTaken(vm)) ? null : vm;
}

/**
 * Setup could not start (its sources were refused): the machine started for
 * it goes, unless something took it.
 */
export async function releaseUntakenEnvironmentMachine(
	workspaceId: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	if (!runtime.delete) return false;
	const vm = await runtime.findBySlug(earlyMachineSlug(workspaceId));
	if (!vm || (await machineTaken(vm))) return false;
	await runtime.delete(vm);
	return true;
}
