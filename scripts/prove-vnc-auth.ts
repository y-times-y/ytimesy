// Live check, development only: boots one VM from the tools snapshot, starts
// the desktop with the product's script as the builder, then speaks RFB on
// x11vnc's Unix socket and asserts the server offers a password (2, or
// TLS/VeNCrypt) and never None (1). Deletes the VM whatever happens.
//   node --env-file=.env --import tsx scripts/prove-vnc-auth.ts
import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { productCreateVmFields } from "#/server/adapters/freestyle/product-vm";
import {
	DESKTOP_CREDENTIAL_DROP_SETUP,
	DESKTOP_PRIVATE_READY,
	START_WORKSPACE_DESKTOP,
} from "#/server/adapters/freestyle/start-desktop";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "#/server/adapters/freestyle/desktop-wallpaper";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { RFB_SECURITY_PY, rfbRequiresPassword } from "./vnc-rfb-probe";

const key = process.env.FREESTYLE_API_KEY;
const snapshotId = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
if (!key || !snapshotId)
	throw new Error("Freestyle key and tools snapshot are required.");
const client = new Freestyle({ apiKey: key });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
let vmId = "";
let passed = false;
try {
	const created = await client.vms.create({
		...productCreateVmFields({
			slug: `ytimesy-vnc-proof-${randomUUID().slice(0, 8)}`,
			snapshotId,
		}),
		ttlSeconds: 1200,
		maxRunTotalSeconds: 900,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-vnc-proof" },
	});
	vmId = created.vmId;
	await waitUntilVmRunning(created.vm, "VNC proof");
	const who = await created.vm.exec({ command: "id -un", timeoutMs: 15_000 });
	const setup = await created.vm.exec({
		command: DESKTOP_CREDENTIAL_DROP_SETUP,
		timeoutMs: 15_000,
	});
	if (!(setup.stdout ?? "").includes(DESKTOP_PRIVATE_READY))
		throw new Error("Desktop private directory refused.");
	await created.vm.fs.writeFile(
		DESKTOP_WALLPAPER_B64_PATH,
		desktopWallpaperBase64(),
	);
	const start = await created.vm.exec({
		command: START_WORKSPACE_DESKTOP,
		timeoutMs: 300_000,
	});
	console.log(
		`desktop start as ${who.stdout.trim()}: exit ${start.statusCode}`,
	);
	if (start.statusCode !== 0)
		console.log((start.stderr ?? "").split("\n").slice(-8).join("\n"));
	const probe = await created.vm.exec({
		command: `printf %s ${b64(RFB_SECURITY_PY)} | base64 -d > /tmp/.rfb-$$.py && python3 /tmp/.rfb-$$.py "$HOME/.ytimesy/vnc/rfb.sock"; rm -f /tmp/.rfb-$$.py`,
		timeoutMs: 60_000,
	});
	const answer = (probe.stdout ?? "").trim();
	passed = rfbRequiresPassword(answer);
	console.log(
		`RFB on the Unix socket as the builder: ${answer || "no answer"}`,
	);
	if (!passed) {
		const log = await created.vm.exec({
			command:
				"tail -n 15 /tmp/ytimesy-desk.log; pgrep -a -x x11vnc | sed 's/-passwdfile [^ ]*/-passwdfile <file>/'",
			timeoutMs: 15_000,
		});
		console.log(log.stdout);
	}
	console.log(passed ? "PASS: password required, None not offered" : "FAIL");
} finally {
	if (vmId) {
		await client.vms.delete(vmId).then(
			() => console.log("VM deleted"),
			(e) => console.log(`VM delete failed: ${(e as Error).message}`),
		);
	}
}
process.exitCode = passed ? 0 : 1;
