import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { WorkspaceId } from "#/domain/ids";
import { CHEAP_BASE_SNAPSHOT } from "#/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "#/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { apiAgentBrowserTools } from "#/server/services/api-agent-browser-tools";
import { apiAgentCommandTools } from "#/server/services/api-agent-command-tools";
import { apiAgentFileTools } from "#/server/services/api-agent-file-tools";

const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Freestyle key is required.");
const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const id = randomUUID();
let vmId: string | undefined;

async function invoke(tool: unknown, args: Record<string, unknown>) {
	return (
		tool as {
			execute: (
				args: Record<string, unknown>,
				options: { toolCallId: string },
			) => Promise<unknown>;
		}
	).execute(args, { toolCallId: randomUUID() });
}

try {
	const created = await client.vms.create({
		slug: `ytimesy-api-tools-${id.slice(0, 8)}`,
		snapshotId: CHEAP_BASE_SNAPSHOT,
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 600,
		maxRunTotalSeconds: 420,
		idleTimeoutSeconds: 360,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-api-tool-proof" },
	});
	vmId = created.vmId;
	const guest = await waitUntilVmRunning(created.vm, "API tool proof");
	if (guest.resources.cpu > 8 || guest.resources.memory > 16384)
		throw new Error("Proof VM exceeds the resource envelope.");
	const vm = WorkspaceId(vmId);
	const cwd = "/home/ubuntu/ytimesy-api-tool-proof";
	const setup = await machines.exec(
		vm,
		`mkdir -p ${cwd} && git -C ${cwd} init -q`,
		20_000,
	);
	if (setup.exitCode)
		throw new Error("Could not prepare disposable repository.");
	const context = {
		machines,
		vm,
		cwd,
		readOnly: false,
		signal: new AbortController().signal,
		once: async (_id: string, run: () => Promise<unknown>) => run(),
	};
	const files = apiAgentFileTools(context);
	const commands = apiAgentCommandTools({
		...context,
		sessionId: id,
		turnId: id,
	});
	const browser = apiAgentBrowserTools(context);
	await invoke(files.create_file, { path: "proof.txt", content: "first\n" });
	await invoke(files.replace_text, {
		path: "proof.txt",
		old: "first",
		new: "second",
	});
	const started = (await invoke(commands.start_command, {
		command: "sleep 2; cat proof.txt",
		maxSeconds: 30,
	})) as { id: string };
	let result = "";
	for (let attempt = 0; attempt < 30; attempt++) {
		result = (await invoke(commands.read_command, {
			id: started.id,
		})) as string;
		if (result.includes("STATUS=0")) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	if (!result.includes("STATUS=0") || !result.includes("second"))
		throw new Error(`Long command did not complete: ${result.slice(-500)}`);
	const verified = (await invoke(files.verify_changes, {})) as {
		passed: boolean;
	};
	if (!verified.passed) throw new Error("Repository verification failed.");
	try {
		await invoke(browser.browser_open, { url: "http://localhost:3000/" });
	} catch (error) {
		const diagnostic = await machines
			.exec(
				vm,
				"command -v google-chrome-stable || true; command -v chromium || true; tail -n 15 /tmp/ytimesy-chrome-install.log 2>/dev/null || true",
				10_000,
			)
			.catch(() => null);
		console.info(
			JSON.stringify({
				browserSetup: diagnostic?.stdout?.slice(-1600) ?? "unavailable",
			}),
		);
		throw error;
	}
	const screenshot = (await invoke(browser.browser_screenshot, {})) as {
		base64: string;
	};
	if (
		!Buffer.from(screenshot.base64, "base64")
			.subarray(0, 8)
			.equals(Buffer.from("89504e470d0a1a0a", "hex"))
	)
		throw new Error("Browser screenshot was not a PNG image.");
	console.info(
		"Disposable API file-edit, long-command, and browser proof passed.",
	);
} finally {
	if (vmId) {
		await client.vms.ref(vmId).delete();
		console.info("Disposable proof VM deleted.");
	}
}
