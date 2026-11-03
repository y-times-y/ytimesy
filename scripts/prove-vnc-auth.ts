// Live check, development only: boots one VM from the tools snapshot, starts
// the desktop with the product's script as the builder, publishes its viewer
// route, and proves the VNC server's auth end to end:
//   - TigerVNC (X0tigervnc) serves on the Unix socket only, no TCP 590x;
//   - its handshake offers a password (2, or TLS/VeNCrypt), never None (1);
//   - the route refuses no or a wrong credential;
//   - with the route credential, a wrong VNC password is refused, the right
//     one accepted;
//   - a new credential pair applies in place: the old route credential and
//     old VNC password are refused, the new ones accepted, and the VNC server
//     and the display keep running.
// Deletes the route and the VM whatever happens.
//   node --env-file=.env --import tsx scripts/prove-vnc-auth.ts
import { randomBytes, randomUUID } from "node:crypto";
import { Freestyle, type Vm } from "freestyle";
import WebSocket from "ws";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "#/server/adapters/freestyle/desktop-wallpaper";
import {
	publishVmEdgeRoute,
	withdrawVmEdgeRoutes,
} from "#/server/adapters/freestyle/edge-routes";
import { productCreateVmFields } from "#/server/adapters/freestyle/product-vm";
import {
	DESKTOP_CREDENTIAL_DROP_SETUP,
	DESKTOP_PRIVATE_READY,
	DESKTOP_VIEWER_CREDENTIAL_PATH,
	DESKTOP_VNC_PASSWORD_PATH,
	START_WORKSPACE_DESKTOP,
} from "#/server/adapters/freestyle/start-desktop";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { desktopEdgeHostname } from "#/server/services/vm-edge-keys";
import {
	RFB_SECURITY_PY,
	rfbRequiresPassword,
	vncPasswordAuthenticates,
} from "./vnc-rfb-probe";

const key = process.env.FREESTYLE_API_KEY;
const snapshotId = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
if (!key || !snapshotId)
	throw new Error("Freestyle key and tools snapshot are required.");
const client = new Freestyle({ apiKey: key });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};
const credentials = () => ({
	viewer: `ytimesy:${randomBytes(20).toString("hex")}`,
	vnc: randomBytes(4).toString("hex"),
});
const basic = (viewer: string) => ({
	authorization: `Basic ${Buffer.from(viewer).toString("base64")}`,
});

async function exec(vm: Vm, command: string, timeoutMs = 60_000) {
	const result = await vm.exec({ command, timeoutMs });
	return {
		code: result.statusCode,
		out: (result.stdout ?? "").trim(),
		err: (result.stderr ?? "").trim(),
	};
}

/** What a Desktop open does: private directory, credential drop, start script. */
async function startDesktop(vm: Vm, pair: ReturnType<typeof credentials>) {
	const setup = await exec(vm, DESKTOP_CREDENTIAL_DROP_SETUP, 15_000);
	if (!setup.out.includes(DESKTOP_PRIVATE_READY))
		throw new Error("Desktop private directory refused.");
	await vm.fs.writeTextFile(DESKTOP_VIEWER_CREDENTIAL_PATH, pair.viewer);
	await vm.fs.writeTextFile(DESKTOP_VNC_PASSWORD_PATH, pair.vnc);
	return exec(vm, START_WORKSPACE_DESKTOP, 300_000);
}

/** HTTP status of a WebSocket upgrade (101 when it opens). */
function upgradeStatus(url: string, headers: Record<string, string>) {
	return new Promise<number | string>((resolve) => {
		const socket = new WebSocket(url, ["binary"], {
			headers,
			handshakeTimeout: 10_000,
		});
		socket.on("open", () => {
			socket.terminate();
			resolve(101);
		});
		socket.on("unexpected-response", (_request, response) => {
			resolve(response.statusCode ?? "?");
			socket.terminate();
		});
		socket.on("error", (error) => resolve(`error ${error.message}`));
	});
}

const vncPids = (vm: Vm) =>
	exec(vm, "pgrep -x X0tigervnc; pgrep -x Xvfb; pgrep -x x11vnc || true").then(
		(r) => r.out.replace(/\n/g, ","),
	);

let vmId = "";
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
	const vm = created.vm;
	await waitUntilVmRunning(vm, "VNC proof");
	await vm.fs.writeFile(DESKTOP_WALLPAPER_B64_PATH, desktopWallpaperBase64());
	const first = credentials();
	const who = await exec(vm, "id -un", 15_000);
	const start = await startDesktop(vm, first);
	record(
		`desktop start as ${who.out}`,
		start.code === 0,
		`exit ${start.code}${start.code === 0 ? "" : ` ${start.err.split("\n").slice(-4).join(" | ")}`}`,
	);

	const server = await exec(
		vm,
		"pgrep -a -x X0tigervnc | sed 's/-PasswordFile [^ ]*/-PasswordFile <file>/'",
	);
	record(
		"VNC server is TigerVNC on the Unix socket, VncAuth with a password file",
		/X0tigervnc /.test(server.out) &&
			server.out.includes("-rfbport -1") &&
			server.out.includes("-rfbunixpath") &&
			server.out.includes("-SecurityTypes VncAuth") &&
			server.out.includes("-PasswordFile"),
		server.out || "not running",
	);
	const tcp = await exec(
		vm,
		"sudo -n ss -ltnH 2>/dev/null | grep -E ':590[0-9][[:space:]]' | awk '{print $4}' | tr '\\n' ' '",
	);
	record("no VNC listener on TCP 590x", tcp.out === "", tcp.out || "none");
	const socketMode = await exec(
		vm,
		'stat -c "%a %U" "$HOME/.ytimesy/vnc" "$HOME/.ytimesy/vnc/rfb.sock"',
	);
	record(
		"socket directory 0700 and socket 0600, the builder's",
		/^700 \S+\n600 \S+$/.test(socketMode.out),
		socketMode.out.replace("\n", "; "),
	);
	const probe = await exec(
		vm,
		`printf %s ${b64(RFB_SECURITY_PY)} | base64 -d > /tmp/.rfb-$$.py && python3 /tmp/.rfb-$$.py "$HOME/.ytimesy/vnc/rfb.sock"; rm -f /tmp/.rfb-$$.py`,
	);
	record(
		"RFB on the socket offers a password, never None",
		rfbRequiresPassword(probe.out),
		probe.out || "no answer",
	);

	const hostname = desktopEdgeHostname(vmId);
	await publishVmEdgeRoute(client, vmId, { hostname, port: 6080 });
	const url = `wss://${hostname}/websockify`;
	// The route takes a moment to serve; wait for the right credential first.
	for (let i = 0; i < 60; i++) {
		if ((await upgradeStatus(url, basic(first.viewer))) === 101) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	const none = await upgradeStatus(url, {});
	record("route, no credential", none === 401 || none === 403, `HTTP ${none}`);
	const wrongViewer = await upgradeStatus(url, basic(credentials().viewer));
	record(
		"route, wrong credential",
		wrongViewer === 401 || wrongViewer === 403,
		`HTTP ${wrongViewer}`,
	);
	const wrongVnc = await vncPasswordAuthenticates(
		url,
		basic(first.viewer),
		credentials().vnc,
	);
	record("VNC, wrong password refused", !wrongVnc, `accepted ${wrongVnc}`);
	const rightVnc = await vncPasswordAuthenticates(
		url,
		basic(first.viewer),
		first.vnc,
	);
	record("VNC, right password accepted", rightVnc, `accepted ${rightVnc}`);

	const before = await vncPids(vm);
	const second = credentials();
	const rotate = await startDesktop(vm, second);
	const after = await vncPids(vm);
	const oldViewer = await upgradeStatus(url, basic(first.viewer));
	const oldVnc = await vncPasswordAuthenticates(
		url,
		basic(second.viewer),
		first.vnc,
	);
	const newVnc = await vncPasswordAuthenticates(
		url,
		basic(second.viewer),
		second.vnc,
	);
	record(
		"rotation: old route credential refused",
		oldViewer === 401 || oldViewer === 403,
		`HTTP ${oldViewer}`,
	);
	record("rotation: old VNC password refused", !oldVnc, `accepted ${oldVnc}`);
	record("rotation: new pair accepted", newVnc, `accepted ${newVnc}`);
	record(
		"rotation in place: VNC server and display not restarted",
		rotate.code === 0 && before === after && before.split(",").length >= 2,
		`exit ${rotate.code}; pids ${before} -> ${after}`,
	);
} catch (error) {
	record("proof ran", false, (error as Error).message.slice(0, 300));
} finally {
	if (vmId) {
		await withdrawVmEdgeRoutes(client, vmId, ["desk"]).catch(() => 0);
		await client.vms.delete(vmId).then(
			() => console.log("route and VM deleted"),
			(e) => console.log(`VM delete failed: ${(e as Error).message}`),
		);
	}
}
const failed = results.filter((r) => !r.ok).length;
console.log(
	failed
		? `FAIL: ${failed} of ${results.length}`
		: `PASS: all ${results.length}`,
);
process.exitCode = failed ? 1 : 0;
