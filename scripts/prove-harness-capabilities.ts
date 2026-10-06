import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { WorkspaceId } from "#/domain/ids";
import { CHEAP_BASE_SNAPSHOT } from "#/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "#/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { apiAgentFileTools } from "#/server/services/api-agent-file-tools";
import { runGuestCapability } from "#/server/services/guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQueryResult,
} from "#/server/services/language-intelligence";

if (!process.argv.includes("--live"))
	throw new Error("Explicit --live required for disposable compute.");
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Freestyle connection unavailable.");
const client = new Freestyle({ apiKey: key });
const productMachines = createFreestyleWorkspaceMachines(key);
let vmId: string | undefined;
const started = Date.now();
try {
	const created = await client.vms.create({
		slug: `ytimesy-capability-proof-${randomUUID().slice(0, 8)}`,
		snapshotId: CHEAP_BASE_SNAPSHOT,
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 420,
		maxRunTotalSeconds: 360,
		idleTimeoutSeconds: 360,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-harness-capability-proof" },
	});
	vmId = created.vmId;
	const requireProofVm = (target: string) => {
		if (target !== created.vmId)
			throw new Error("Capability proof cannot access another VM.");
		return created.vm;
	};
	// This fixture owns its disposable VM directly, not an application workspace.
	// Product admission stays unchanged; every proof transport is bound to this VM.
	const machines = {
		...productMachines,
		async exec(target: string, command: string, timeoutMs = 30000) {
			const result = await requireProofVm(target).exec({ command, timeoutMs });
			return {
				exitCode: result.statusCode ?? 124,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		},
		async writeTextFile(target: string, path: string, content: string) {
			await requireProofVm(target).fs.writeTextFile(path, content);
		},
		async readTextFile(target: string, path: string) {
			return requireProofVm(target).fs.readTextFile(path);
		},
	};
	const guest = await waitUntilVmRunning(
		created.vm,
		"Harness capability proof",
	);
	if (guest.resources.cpu > 4 || guest.resources.memory > 8192)
		throw new Error("Proof exceeds its resource envelope.");
	const cwd = "/home/ubuntu/ytimesy-capability-proof";
	const workspace = { machines, vm: WorkspaceId(vmId), cwd };
	const setup = await machines.exec(
		workspace.vm,
		`mkdir -p ${cwd} && git -C ${cwd} init -q && node --version && npm --version`,
		20000,
	);
	if (setup.exitCode)
		throw new Error("Proof VM lacks Node/npm; no installation guessed.");
	const content = "export const answer = 42;\nconsole.log(answer);\n";
	await machines.writeTextFile(workspace.vm, `${cwd}/index.ts`, content);
	await machines.writeTextFile(
		workspace.vm,
		`${cwd}/tsconfig.json`,
		'{"compilerOptions":{"strict":true}}',
	);
	const signal = AbortSignal.timeout(240000);
	const refs = await runGuestCapability(
		workspace,
		"language",
		LANGUAGE_INTELLIGENCE_SOURCE,
		{ cwd, path: "index.ts", operation: "references", line: 1, column: 14 },
		languageQueryResult,
		signal,
	);
	if (!Array.isArray(refs.result) || refs.result.length !== 2)
		throw new Error("Real guest references failed.");
	const rename = await runGuestCapability(
		workspace,
		"language",
		LANGUAGE_INTELLIGENCE_SOURCE,
		{
			cwd,
			path: "index.ts",
			operation: "rename_preview",
			line: 1,
			column: 14,
			newName: "renamed",
		},
		languageQueryResult,
		signal,
	);
	if (!JSON.stringify(rename.result).includes('"newText":"renamed"'))
		throw new Error("Real guest rename preview failed.");
	if (
		(await machines.readTextFile(workspace.vm, `${cwd}/index.ts`)) !== content
	)
		throw new Error("Read-only language inspection changed source.");
	const tools = apiAgentFileTools({
		...workspace,
		signal,
		readOnly: false,
		nativePatch: true,
		once: async (_id, run) => run(),
	});
	if (!tools.apply_patch.execute)
		throw new Error("Native patch executor unavailable.");
	const patch = await tools.apply_patch.execute(
		{
			operation: {
				type: "update_file",
				path: "index.ts",
				diff: "@@\n-export const answer = 42;\n+export const answer = 43;\n console.log(answer);",
			},
		},
		{ toolCallId: randomUUID(), messages: [], context: undefined },
	);
	if (
		typeof patch !== "object" ||
		patch === null ||
		!("status" in patch) ||
		patch.status !== "completed"
	)
		throw new Error("Guest native patch failed.");
	if (
		!(await machines.readTextFile(workspace.vm, `${cwd}/index.ts`))?.includes(
			"answer = 43",
		)
	)
		throw new Error("Patch was not applied.");
	console.info(
		JSON.stringify({
			liveGuestReferences: "passed",
			liveGuestRenamePreview: "passed_without_edits",
			liveGuestNativePatch: "passed",
			elapsedMs: Date.now() - started,
			resources: guest.resources,
			inferenceRequests: 0,
		}),
	);
} finally {
	if (vmId) {
		await client.vms.ref(vmId).delete();
		console.info(
			"Disposable capability proof VM deleted; no snapshot created.",
		);
	}
}
