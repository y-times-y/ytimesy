// Focused live check of two VM fixes, from local code against one dev VM:
// the per-turn metadata block now covers Docker task containers (DOCKER-USER)
// and read-only git works for a reader inside its network namespace. Applies
// guestMetadataBlockCommand() from this checkout (the deployed edge is not
// involved). No model runs; prints no secret.
//
//   VM_SECURITY_PROOF=1 node --env-file=.env --import tsx scripts/prove-vm-container-reader.ts
//
// Development only. The eval user, chat and VM are removed in `finally`.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Freestyle } from "freestyle";
import { guestMetadataBlockCommand } from "../src/domain/guest-network-guard";
import { WorkspaceId } from "../src/domain/ids";
import {
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { closeDatabase, database } from "../src/server/adapters/database";
import { productCreateVmFields } from "../src/server/adapters/freestyle/product-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import { readerWorkspaceMachines } from "../src/server/services/reader-workspace-machines";
import { createEvalUser } from "./smoke/eval-user";

const DEV_REF = "exampledevprojectref";
const PROD_REF = "exampleprojectref";
if (process.env.VM_SECURITY_PROOF !== "1")
	throw new Error("Enable VM_SECURITY_PROOF=1.");
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== DEV_REF ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF) ||
	`${process.env.DATABASE_URL}${process.env.APP_URL}`.includes(PROD_REF) ||
	`${process.env.APP_URL}${process.env.BETTER_AUTH_URL}`.includes("ytimesy.com")
)
	throw new Error("Refusing to run: not the development environment.");
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("FREESTYLE_API_KEY is required.");

const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const results: string[] = [];
const cleanup: string[] = [];
const leftovers: string[] = [];
const exec = (vm: string, command: string, ms = 60_000) =>
	machines.exec(WorkspaceId(vm), command, ms);
const record = (pass: boolean, check: string, evidence: string) => {
	const line = `[${pass ? "PASS" : "FAIL"}] ${check}: ${evidence}`;
	results.push(line);
	console.log(line);
};
const containerProbe =
	'sudo -n docker run --rm --entrypoint sh curlimages/curl:8.10.1 -c "echo PUT=\\$(curl -s -m 4 -o /dev/null -w %{http_code} -X PUT -H X-aws-ec2-metadata-token-ttl-seconds:60 http://169.254.169.254/latest/api/token) GET=\\$(curl -s -m 4 -o /dev/null -w %{http_code} http://169.254.169.254/latest/meta-data/)" 2>&1 | tail -1';

const user = await createEvalUser({ label: "vm-container-reader" });
cleanup.push("eval user created");
let vm = "";
try {
	const session = await insertAgentSession({
		userId: user.userId,
		projectId: user.project.projectId,
		workspaceId: user.project.workspaceId,
		harness: "codex",
		title: "VM container/reader check",
	});
	const template = (
		await database().query<{ template_snapshot_id: string | null }>(
			"select template_snapshot_id from workspace where id=$1",
			[user.project.workspaceId],
		)
	).rows[0]?.template_snapshot_id;
	if (!template)
		throw new Error("The copied project has no prepared environment.");
	const created = await client.vms.create({
		...productCreateVmFields({
			slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			snapshotId: template,
		}),
		ttlSeconds: 2400,
		maxRunTotalSeconds: 1800,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-vm-container-reader" },
	} as never);
	vm = created.vmId;
	await user.trackVm(vm);
	await waitUntilVmRunning(created.vm, "VM container/reader check");
	await saveAgentSessionProviderRef(session.id, vm);
	console.log("Setup: VM running.");

	// 1. Container metadata: baseline, the per-turn block (twice), then again.
	const docker = await exec(
		vm,
		"sudo -n docker info >/dev/null 2>&1 && echo ready || echo missing",
		60_000,
	);
	if (!docker.stdout.includes("ready")) {
		record(false, "container metadata", "docker unavailable on the VM");
	} else {
		await exec(
			vm,
			"sudo -n docker pull -q curlimages/curl:8.10.1 >/dev/null 2>&1",
			240_000,
		);
		const before = (await exec(vm, containerProbe, 120_000)).stdout.trim();
		const blocks = [
			await exec(vm, guestMetadataBlockCommand(), 30_000),
			await exec(vm, guestMetadataBlockCommand(), 30_000),
		];
		const counts = (
			await exec(
				vm,
				"for t in iptables ip6tables; do printf '%s ' \"$(sudo -n $t -S DOCKER-USER 2>/dev/null | grep -c -- '-j REJECT')\"; done",
				15_000,
			)
		).stdout.trim();
		const after = (await exec(vm, containerProbe, 120_000)).stdout.trim();
		const builderPut = (
			await exec(
				vm,
				"curl -s -m 4 -o /dev/null -w %{http_code} -X PUT -H X-aws-ec2-metadata-token-ttl-seconds:60 http://169.254.169.254/latest/api/token",
				30_000,
			)
		).stdout.trim();
		record(
			blocks.every((b) => b.exitCode === 0) &&
				/PUT=000 GET=000/.test(after) &&
				counts === "2 1" &&
				builderPut === "000",
			"container metadata (FORWARD/DOCKER-USER)",
			`before block ${before}; block exits ${blocks.map((b) => b.exitCode).join(",")}; DOCKER-USER REJECT rules v4/v6 ${counts}; after block ${after}; builder PUT ${builderPut}`,
		);
	}

	// 2. Reader read-only git inside its namespace.
	const checkout = (
		await machines.readTextFile(WorkspaceId(vm), "/tmp/ytimesy-project-cwd")
	)?.trim();
	const reader = readerWorkspaceMachines(machines, {
		sessionId: `vmsec-${randomUUID()}`,
		sessionRoot: `/tmp/ytimesy-sessions/vmsec-${randomUUID()}`,
		scope: (text) => text,
	});
	const git = await reader.exec(
		WorkspaceId(vm),
		checkout
			? `cd '${checkout.replaceAll("'", "'\\''")}' && for c in "log -1 --format=%h" "diff --stat HEAD -- . :!.env*" "show --stat --format=%h HEAD" "status --short"; do out=$(git $c 2>&1); echo "git \${c%% *}: exit=$? $(printf %s "$out" | tail -1 | cut -c1-120)"; done; echo "netns links: $(ip -o link | awk -F': ' '{print $2}' | tr '\\n' ' ')"`
			: 'echo "no checkout"',
		120_000,
	);
	const out = git.stdout.trim();
	console.log(out);
	if (checkout) {
		const q = `'${checkout.replaceAll("'", "'\\''")}'`;
		const builderView = await exec(
			vm,
			`cd ${q} && echo "builder git log: $(git log -1 --format=%h >/dev/null 2>&1; echo $?)"; ls -ld . .git .git/HEAD .git/objects 2>&1 | awk '{print $1, $3, $NF}'; head -c 60 .git 2>/dev/null | grep gitdir; namei -m ${q}/.git/HEAD 2>&1 | tail -6`,
			30_000,
		);
		const readerView = await reader.exec(
			WorkspaceId(vm),
			`cd ${q} && ls -ld .git .git/HEAD 2>&1; cat .git/HEAD 2>&1 | head -1; GIT_TRACE_SETUP=1 git rev-parse --git-dir 2>&1 | tail -4`,
			30_000,
		);
		console.log(
			`--- builder view\n${builderView.stdout}${builderView.stderr}\n--- reader view\n${readerView.stdout}${readerView.stderr}`,
		);
	}
	record(
		/git log: exit=0/.test(out) &&
			/git diff: exit=0/.test(out) &&
			/git show: exit=0/.test(out) &&
			/git status: exit=0/.test(out) &&
			/netns links: lo $/.test(
				`${out.split("\n").at(-1)} `.replace(/\s+$/, " "),
			),
		"reader read-only git in its netns",
		out
			.split("\n")
			.map((l) => l.replace(/:.*?exit=/, " exit=").slice(0, 60))
			.join("; "),
	);
} catch (error) {
	record(
		false,
		"run",
		error instanceof Error ? error.message.slice(0, 200) : String(error),
	);
} finally {
	if (vm)
		await machines.destroy(WorkspaceId(vm)).then(
			() => cleanup.push("VM deleted"),
			() => leftovers.push(`vm:${vm}`),
		);
	const released = await user
		.release()
		.catch((error) => [String(error).slice(0, 200)]);
	if (released.length) leftovers.push(...released);
	else cleanup.push("eval user, chat, project copy and VM records deleted");
	await closeDatabase().catch(() => undefined);
	console.log(`\n${results.join("\n")}\nCleanup: ${cleanup.join("; ")}.`);
	console.log(
		leftovers.length
			? `LEFTOVERS: ${leftovers.join(", ")}`
			: "Leftovers: none.",
	);
	process.exitCode = results.every((r) => r.startsWith("[PASS]")) ? 0 : 1;
}
