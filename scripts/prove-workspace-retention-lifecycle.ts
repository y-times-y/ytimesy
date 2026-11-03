import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { repositoriesForProject } from "#/domain/projects";
import {
	deleteAgentSessionForOwner,
	saveAgentSessionProviderRef,
} from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { reconcilePausedVm } from "#/server/adapters/freestyle/usage-admission";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import {
	recycleWorkspace,
	restoreRetainedWorkspace,
	retainedTreeDigest,
} from "#/server/adapters/freestyle/workspace-retention";
import { projectForOwner } from "#/server/adapters/projects";
import { repositoryDirectory } from "#/server/adapters/repository-setup";
import { openAgentSession } from "#/server/services/agent-session-machine";

if (
	!process.argv.includes("--run") ||
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
		"zqkptvyvoyqqtpihlshw"
)
	throw new Error(
		"Explicit --run on the approved development project required.",
	);
const owner = process.env.YTIMESY_ADMIN_USER_IDS?.split(",")[0];
if (!owner) throw new Error("An explicit approved admin account is required.");
const prepared = await database().query<{ project_id: string }>(
	"select project_id from workspace where user_id=$1 and status='ready' order by updated_at desc limit 1",
	[owner],
);
const project =
	prepared.rows[0] &&
	(await projectForOwner(owner, prepared.rows[0].project_id));
if (!project) throw new Error("No prepared project.");
const session = await openAgentSession({
	userId: owner,
	projectId: project.id,
	harness: "codex",
});
const slug = agentSessionMachineSlug(session.id);
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY ?? "" });
const machines = createFreestyleWorkspaceMachines(
	process.env.FREESTYLE_API_KEY ?? "",
);
const realNow = Date.now;
let sourceId: string | undefined;
let restoredId: string | undefined;
let snapshotId: string | undefined;
try {
	sourceId = await machines.provisionSession(slug, "freestyle/ubuntu-sm");
	await saveAgentSessionProviderRef(session.id, sourceId);
	await machines.ensureRunning(
		sourceId as Parameters<typeof machines.ensureRunning>[0],
	);
	const source = client.vms.ref(sourceId);
	const roots = repositoriesForProject(project).map((repo) =>
		repositoryDirectory(repo.fullName),
	);
	for (const root of roots) {
		await source.fs.mkdir(root);
		await source.fs.writeTextFile(`${root}/.env`, randomUUID(), {
			mode: 0o600,
		});
		await source.fs.writeFile(`${root}/local.bin`, new Uint8Array([0, 1, 255]));
	}
	// The digest runs in the guest, so take it while the source still runs.
	const expected = await retainedTreeDigest(source, roots);
	await source.pause();
	await reconcilePausedVm(source);
	const enrolled = await database().query(
		"update workspace_retention set last_activity_at=now()-interval '2 hours' where session_id=$1 returning session_id",
		[session.id],
	);
	if (!enrolled.rowCount)
		throw new Error("Disposable workspace was not enrolled.");
	// Simulate the idle clock in this proof process only; do not wait an hour or change provider/account state.
	Date.now = () => realNow() + 2 * 60 * 60 * 1000;
	await recycleWorkspace(client, session.id);
	Date.now = realNow;
	const retained = await database().query<{
		snapshot_id: string;
		phase: string;
	}>("select snapshot_id,phase from workspace_retention where session_id=$1", [
		session.id,
	]);
	snapshotId = retained.rows[0]?.snapshot_id;
	if (retained.rows[0]?.phase !== "retained" || !snapshotId)
		throw new Error("Retirement was not persisted.");
	await source.data().then(
		() => {
			throw new Error("Source VM still exists.");
		},
		(error) => {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				throw error;
		},
	);
	restoredId =
		(await restoreRetainedWorkspace(client, owner, session.id, sourceId)) ??
		undefined;
	if (!restoredId || restoredId === sourceId)
		throw new Error("Recovery did not replace the deleted source.");
	const restored = client.vms.ref(restoredId);
	if ((await retainedTreeDigest(restored, roots)) !== expected)
		throw new Error("Full-state recovery changed ignored data or permissions.");
	await restored.pause();
	const binding = await database().query<{ provider_ref: string }>(
		"select provider_ref from agent_session where id=$1",
		[session.id],
	);
	if (binding.rows[0]?.provider_ref !== restoredId)
		throw new Error("Recovery did not bind the chat.");
	await reconcilePausedVm(restored);
	console.info(
		"PASS: actual application retirement deleted only its disposable source, funded full-state recovery, restored ignored binary/text permissions and rebound the chat. Idle time was simulated, not waited out.",
	);
} finally {
	Date.now = realNow;
	const retained = await database().query<{ snapshot_id: string | null }>(
		"select snapshot_id from workspace_retention where session_id=$1",
		[session.id],
	);
	snapshotId ??= retained.rows[0]?.snapshot_id ?? undefined;
	const owned = await client.vms.list({ slug, limit: 1 });
	for (const data of owned.vms) {
		const vm = client.vms.ref(data.id);
		if ((await vm.data()).state === "running") await vm.pause();
		await reconcilePausedVm(vm);
		await vm.delete();
	}
	if (snapshotId) await client.vms.snapshots.delete(snapshotId);
	await deleteAgentSessionForOwner(owner, session.id);
	await closeDatabase();
	console.info(
		"Disposable session, remaining proof VM and recovery snapshot removed. No existing project VM was changed.",
	);
}
