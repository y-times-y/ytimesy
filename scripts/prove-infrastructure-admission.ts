import { Freestyle } from "freestyle";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { deleteAgentSessionForOwner } from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { reconcilePausedVm } from "#/server/adapters/freestyle/usage-admission";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import {
	settleInfrastructureUsage,
	userInfrastructureUsage,
} from "#/server/adapters/infrastructure-usage";
import { openAgentSession } from "#/server/services/agent-session-machine";

if (!process.argv.includes("--run"))
	throw new Error("Explicit --run required.");
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "true";
const owner = process.env.YTIMESY_ADMIN_USER_IDS?.split(",")[0];
if (!owner) throw new Error("An explicit approved admin account is required.");
const project = await database().query<{ project_id: string }>(
	"select project_id from workspace where user_id=$1 and status='ready' order by updated_at desc limit 1",
	[owner],
);
if (!project.rows[0]) throw new Error("No prepared project.");
const session = await openAgentSession({
	userId: owner,
	projectId: project.rows[0].project_id,
	harness: "codex",
});
const slug = agentSessionMachineSlug(session.id);
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY ?? "" });
const machines = createFreestyleWorkspaceMachines(
	process.env.FREESTYLE_API_KEY ?? "",
);
let vmId: string | undefined;
try {
	vmId = await machines.provisionSession(slug, "freestyle/ubuntu-sm");
	const data = await client.vms.ref(vmId).data();
	if (data.maxRunTotalSeconds !== 300)
		throw new Error("Admission did not cap the created VM.");
	const output = await machines.exec(
		vmId as Parameters<typeof machines.exec>[0],
		"printf usage-proof",
		10_000,
	);
	if (output.stdout !== "usage-proof")
		throw new Error("Budgeted execution failed.");
	const before = await userInfrastructureUsage(owner);
	if (before.reservedMicroUsd < 13224) throw new Error("VM was not prepaid.");
	await client.vms.ref(vmId).pause();
	await reconcilePausedVm(client.vms.ref(vmId));
	if ((await userInfrastructureUsage(owner)).reservedMicroUsd !== 0)
		throw new Error(
			"Paused reconciliation retained an unused proof reservation.",
		);
	await machines.ensureRunning(
		vmId as Parameters<typeof machines.ensureRunning>[0],
	);
	const resumed = await client.vms.ref(vmId).data();
	if (
		resumed.totalRunSeconds == null ||
		resumed.maxRunTotalSeconds !== 300 + resumed.totalRunSeconds
	)
		throw new Error("Resume was not separately prepaid.");
	await client.vms.ref(vmId).pause();
	await reconcilePausedVm(client.vms.ref(vmId));
	console.info(
		"PASS: real session create and exec used the owner ledger and confirmed a native runtime cap.",
	);
} finally {
	if (vmId) {
		const data = await client.vms.ref(vmId).data();
		await client.vms.delete(vmId);
		const hold = await database().query<{
			reservation_id: string;
			baseline_seconds: string;
			hourly_micro_usd: string;
		}>(
			"select reservation_id,hourly_micro_usd,baseline_seconds from infrastructure_vm_admission where slug=$1",
			[slug],
		);
		if (
			hold.rows[0] &&
			data.state === "paused" &&
			data.totalRunSeconds != null
		) {
			await settleInfrastructureUsage({
				id: hold.rows[0].reservation_id,
				userId: owner,
				consumedMicroUsd: Math.ceil(
					((data.totalRunSeconds - Number(hold.rows[0].baseline_seconds)) *
						Number(hold.rows[0].hourly_micro_usd)) /
						3600,
				),
			});
			await database().query(
				"delete from infrastructure_vm_admission where slug=$1",
				[slug],
			);
		}
		console.info(
			"Disposable admission VM deleted; settled its confirmed stopped runtime.",
		);
	}
	await deleteAgentSessionForOwner(owner, session.id);
	await closeDatabase();
}
