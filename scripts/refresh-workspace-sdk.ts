import { Freestyle, type VmData } from "freestyle";
import { PINNED_CLAUDE_AGENT_SDK_VERSION } from "../src/domain/guest-cli-pin";
import { STEP_BUDGET_MS } from "../src/domain/model-workflow";
import { database } from "../src/server/adapters/database";
import { withDatabaseScope } from "../src/server/adapters/database-scope";
import { boundedFreestyleFetch } from "../src/server/adapters/freestyle/bounded-fetch";
import { machineFailureDetail } from "../src/server/adapters/freestyle/machine-failure";
import { WORKSPACE_METADATA_PURPOSE } from "../src/server/adapters/freestyle/product-vm";
import {
	admitVmResume,
	infrastructureAdmissionEnabled,
} from "../src/server/adapters/freestyle/usage-admission";
import { waitUntilGuestReady } from "../src/server/adapters/freestyle/wait-until-running";
import { ensureClaudeAgentSdk } from "../src/server/services/claude-agent-sdk";
import { supabaseCertificate } from "./supabase-certificate";

// Dry inventory by default. --apply uses normal metered VM admission and only
// touches machines owned by the user of --session, never unrelated fleet VMs.
// Existing SDK releases and running processes stay in place.
const session = process.argv[process.argv.indexOf("--session") + 1];
if (
	!process.argv.includes("--session") ||
	!/^[a-f0-9-]{36}$/.test(session ?? "")
)
	throw new Error(
		"Pass --session <an owned chat UUID> to scope this maintenance.",
	);
const apply = process.argv.includes("--apply");
const templates = process.argv.includes("--refresh-templates");
const key = process.env.FREESTYLE_API_KEY;
const connection = process.env.DATABASE_URL;
if (!key || !connection)
	throw new Error("FREESTYLE_API_KEY and DATABASE_URL are required.");
if (apply && !infrastructureAdmissionEnabled())
	throw new Error(
		"SDK maintenance requires normal infrastructure usage admission.",
	);
const client = new Freestyle({ apiKey: key, fetch: boundedFreestyleFetch() });
let failed = 0;

await withDatabaseScope(
	connection,
	async () => {
		const owned = await database().query<{
			provider_ref: string;
			user_id: string;
		}>(
			`with owner as(select user_id from agent_session where id=$1)
		 select distinct provider_ref,user_id from (
		 select provider_ref,user_id from agent_session where user_id=(select user_id from owner)
		 union select provider_ref,user_id from workspace where user_id=(select user_id from owner)
		 ) q where provider_ref is not null`,
			[session],
		);
		if (!owned.rows.length)
			throw new Error("No owned machines found for this chat.");
		const byId = new Map(
			owned.rows.map((row) => [row.provider_ref, row.user_id]),
		);
		const inventory: VmData[] = [];
		for (let offset = 0; ; offset += 100) {
			const page = await client.vms.list({ limit: 100, offset });
			inventory.push(
				...page.vms.filter(
					(vm) =>
						byId.has(vm.id) &&
						vm.metadata?.purpose === WORKSPACE_METADATA_PURPOSE,
				),
			);
			if (offset + 100 >= page.totalCount) break;
		}
		console.log(
			JSON.stringify({
				sdk: PINNED_CLAUDE_AGENT_SDK_VERSION,
				apply,
				machines: inventory.length,
				absentBindings: owned.rows.filter(
					(row) => !inventory.some((vm) => vm.id === row.provider_ref),
				).length,
			}),
		);
		// Resume paused machines one at a time to avoid provider cold-start pressure.
		for (const entry of inventory) {
			if (!apply) {
				console.log(JSON.stringify({ vm: entry.id, state: entry.state }));
				continue;
			}
			try {
				const vm = client.vms.ref(entry.id);
				await admitVmResume(vm, await vm.data(), 30);
				await waitUntilGuestReady(vm, "SDK maintenance");
				const ready = await ensureClaudeAgentSdk({
					shell: async (command, timeoutMs) => {
						await admitVmResume(
							vm,
							await vm.data(),
							Math.ceil(timeoutMs / 1000),
						);
						const result = await vm.exec({ command, timeoutMs });
						return {
							exitCode: result.statusCode ?? 124,
							stdout: result.stdout ?? "",
							stderr: result.stderr ?? "",
						};
					},
					turnId: `sdk-maintenance:${entry.id}`,
					deadline: Date.now() + STEP_BUDGET_MS,
					signal: new AbortController().signal,
					redact: () => [key],
				});
				if (ready !== "ready")
					throw new Error(
						"SDK installation is still pending; rerun maintenance to reattach.",
					);
				await client.vms.ref(entry.id).update({
					metadata: {
						claudeAgentSdkVersion: PINNED_CLAUDE_AGENT_SDK_VERSION,
					},
				});
				console.log(
					JSON.stringify({
						vm: entry.id,
						sdk: PINNED_CLAUDE_AGENT_SDK_VERSION,
						state: "verified",
					}),
				);
				if (templates)
					await refreshTemplate(entry.id, byId.get(entry.id) as string);
				// Do not force-pause: a user may have opened Terminal/Desktop during
				// maintenance. The original idle timeout and accounting remain active.
			} catch (error) {
				failed++;
				console.error(
					JSON.stringify({
						vm: entry.id,
						state: "failed",
						detail: machineFailureDetail(error),
					}),
				);
			}
		}
	},
	supabaseCertificate(),
);
if (failed)
	throw new Error(
		`${failed} machines could not be upgraded; successful machines remain updated.`,
	);

async function refreshTemplate(vmId: string, userId: string) {
	const result = await database().query<{
		id: string;
		template_snapshot_id: string;
	}>(
		`select w.id,w.template_snapshot_id from workspace w where w.user_id=$1 and w.provider_ref=$2 and w.status='ready'
		 and w.template_snapshot_id is not null
		 and not exists(select 1 from agent_session s where s.provider_ref=w.provider_ref)
		 and not exists(select 1 from environment_build b where b.workspace_id=w.id and b.status in ('queued','running'))`,
		[userId, vmId],
	);
	for (const row of result.rows) {
		const prefix = `sdk-${row.id.replaceAll("-", "")}-${PINNED_CLAUDE_AGENT_SDK_VERSION.replaceAll(".", "-")}-`;
		const current = await client.vms.snapshots.get(row.template_snapshot_id);
		if (current.public)
			throw new Error("Refusing to refresh a public project template.");
		if (current.slug?.startsWith(prefix)) continue;
		const created = await client.vms.ref(vmId).snapshot({
			slug: `${prefix}${row.template_snapshot_id.slice(-8)}`,
			displayName: `Project template, Claude SDK ${PINNED_CLAUDE_AGENT_SDK_VERSION}`,
			autoDeleteSeconds: -1,
		});
		if (created.snapshot.public) {
			await client.vms.snapshots.delete(created.snapshotId);
			throw new Error(
				"Provider returned a public project template; it was deleted.",
			);
		}
		const updated = await database().query(
			`update workspace w set template_snapshot_id=$4,updated_at=now() where id=$1 and user_id=$2 and provider_ref=$3 and template_snapshot_id=$5
			 and not exists(select 1 from environment_build b where b.workspace_id=w.id and b.status in ('queued','running'))`,
			[row.id, userId, vmId, created.snapshotId, row.template_snapshot_id],
		);
		if (!updated.rowCount)
			throw new Error(
				"The environment changed during maintenance; its template was not replaced.",
			);
		console.log(
			JSON.stringify({
				workspace: row.id,
				snapshot: created.snapshotId,
				state: "template-refreshed",
			}),
		);
	}
}
