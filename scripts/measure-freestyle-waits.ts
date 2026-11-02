import { Freestyle } from "freestyle";
import WebSocket from "ws";
import { copiedSessionScratchResetCommands } from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import { desktopRemoteOrigin } from "#/domain/workspace-desktop";
import { productCreateVmFields } from "#/server/adapters/freestyle/product-vm";
import { forgetRunningGuest } from "#/server/adapters/freestyle/recent-guest-state";
import { prepareTemplateSnapshot } from "#/server/adapters/freestyle/template-snapshot";
import { waitUntilGuestReady } from "#/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import {
	desktopEdgeHostname,
	desktopViewerAuthorization,
	desktopVncPassword,
} from "#/server/services/vm-edge-keys";
import {
	ensureDesktopProcesses,
	publishDesktopViewer,
} from "#/server/services/workspace-desktop";

// Measures the provider side of each user-visible wait on real Freestyle VMs
// (dev account), with every provider call logged:
//   (a) a new chat's machine ready   (b) an idle chat's machine wake
//   (c) the desktop panel: new chat, running chat, idle chat (to the VNC banner)
//   (d) the first tool call in a chat
//
//   node --env-file=../cloud-launch/.env --import tsx scripts/measure-freestyle-waits.ts --run [--runs 2] [--template sh-...]
//
// It makes one template VM and snapshot (unless --template names one) and one
// copy per run, and deletes all of them at the end. Usage admission is off:
// its ledger round trips are not measured here.

if (!process.argv.includes("--run"))
	throw new Error("Explicit --run required (creates and deletes dev VMs).");
const arg = (name: string) => {
	const at = process.argv.indexOf(name);
	return at > 0 ? process.argv[at + 1] : undefined;
};
const runs = Number(arg("--runs") ?? 2);
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const key = process.env.FREESTYLE_API_KEY ?? "";
const tools = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
if (!key || !tools)
	throw new Error(
		"FREESTYLE_API_KEY and YTIMESY_TOOLS_SNAPSHOT_ID are required.",
	);

type Call = { at: number; ms: number; label: string };
let calls: Call[] = [];
let phaseStart = Date.now();
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const started = Date.now();
	try {
		return await realFetch(input, init);
	} finally {
		if (url.hostname.includes("freestyle")) {
			let detail = "";
			try {
				const body = JSON.parse(String(init?.body ?? "{}"));
				detail = String(body.command ?? body.path ?? "")
					.split("\n")[0]
					.slice(0, 40);
			} catch {}
			const path = url.pathname
				.replace(/\/v5\/vms\/[^/]+/, "/vms/:id")
				.replace(/\/snapshots\/[^/]+/, "/snapshots/:id");
			calls.push({
				at: started - phaseStart,
				ms: Date.now() - started,
				label: `${init?.method ?? "GET"} ${path} ${detail}`.trim(),
			});
		}
	}
}) as typeof fetch;

const machines = createFreestyleWorkspaceMachines(key);
const client = new Freestyle({ apiKey: key });
const results: Record<string, number[]> = {};

async function phase<T>(name: string, run: () => Promise<T>) {
	calls = [];
	phaseStart = Date.now();
	const value = await run();
	const ms = Date.now() - phaseStart;
	results[name] = [...(results[name] ?? []), ms];
	console.info(`\n${name}: ${ms} ms`);
	for (const call of calls)
		console.info(
			`  +${String(call.at).padStart(5)} ${String(call.ms).padStart(5)} ms  ${call.label}`,
		);
	return value;
}

/** Until the edge-routed viewer answers a WebSocket with the RFB banner. */
async function viewerBanner(
	vmId: string,
	deadlineMs = 60_000,
	authorization = desktopViewerAuthorization(vmId),
) {
	const origin = desktopRemoteOrigin(desktopEdgeHostname(vmId)).replace(
		/^http/,
		"ws",
	);
	const end = Date.now() + deadlineMs;
	let attempts = 0;
	for (;;) {
		attempts++;
		const ok = await new Promise<boolean>((resolve) => {
			const socket = new WebSocket(origin, ["binary"], {
				headers: { authorization },
			});
			const timer = setTimeout(() => {
				socket.terminate();
				resolve(false);
			}, 10_000);
			socket.on("message", (data) => {
				clearTimeout(timer);
				socket.close();
				resolve(String(data).startsWith("RFB"));
			});
			socket.on("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
		if (ok) return attempts;
		if (Date.now() > end) throw new Error("viewer never answered");
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Full VNC password authentication through the edge, the proxy and x11vnc. */
async function vncAuthenticates(vmId: string, password: string) {
	const { DESECBCipher } = (await import(
		// noVNC's own DES (OpenSSL 3 dropped it), not in its package exports.
		new URL("../node_modules/@novnc/novnc/core/crypto/des.js", import.meta.url)
			.href
	)) as {
		DESECBCipher: {
			importKey(key: number[]): {
				encrypt(a: unknown, x: Uint8Array): Uint8Array;
			};
		};
	};
	const origin = desktopRemoteOrigin(desktopEdgeHostname(vmId)).replace(
		/^http/,
		"ws",
	);
	return new Promise<boolean>((resolve) => {
		const socket = new WebSocket(origin, ["binary"], {
			headers: { authorization: desktopViewerAuthorization(vmId) },
		});
		let buffer = Buffer.alloc(0);
		let stage = 0;
		const done = (ok: boolean) => {
			clearTimeout(timer);
			socket.terminate();
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), 15_000);
		socket.on("error", () => done(false));
		socket.on("message", (data: Buffer) => {
			buffer = Buffer.concat([buffer, data]);
			if (stage === 0 && buffer.length >= 12) {
				buffer = buffer.subarray(12);
				socket.send(Buffer.from("RFB 003.008\n"));
				stage = 1;
			}
			if (stage === 1 && buffer.length >= 1 && buffer.length >= 1 + buffer[0]) {
				const types = [...buffer.subarray(1, 1 + buffer[0])];
				buffer = buffer.subarray(1 + buffer[0]);
				if (!types.includes(2)) return done(false);
				socket.send(Buffer.from([2]));
				stage = 2;
			}
			if (stage === 2 && buffer.length >= 16) {
				const challenge = new Uint8Array(buffer.subarray(0, 16));
				buffer = buffer.subarray(16);
				const key = DESECBCipher.importKey(
					password.split("").map((c) => c.charCodeAt(0)),
				);
				socket.send(Buffer.from(key.encrypt({ name: "DES-ECB" }, challenge)));
				stage = 3;
			}
			if (stage === 3 && buffer.length >= 4) done(buffer.readUInt32BE(0) === 0);
		});
	});
}

async function pauseAndSettle(vmId: string) {
	const vm = client.vms.ref(vmId);
	await vm.pause();
	for (;;) {
		const { state } = await vm.data();
		if (state === "paused") return;
		await new Promise((r) => setTimeout(r, 500));
	}
}

const tag = Date.now().toString(36);
const made: string[] = [];
let templateVm: string | undefined;
let snapshotId = arg("--template");
const ownSnapshot = !snapshotId;
try {
	if (!snapshotId) {
		// As the environment build makes it: the tools image at its own (small) size.
		templateVm = await phase("setup: template VM", async () => {
			const created = await client.vms.create({
				...productCreateVmFields({ slug: `fsf-tpl-${tag}`, snapshotId: tools }),
				maxRunTotalSeconds: 1800,
				automaticRestart: false,
			});
			await waitUntilGuestReady(created.vm, "template");
			return created.vmId;
		});
		if (process.argv.includes("--prepared-template"))
			await phase("setup: prepare template (disk + desktop)", async () => {
				const prepared = await prepareTemplateSnapshot(
					client.vms.ref(templateVm as string),
					{
						storageMiB: 32768,
						desktop: true,
					},
				);
				if (prepared.skipped.length)
					throw new Error(`template preparation skipped ${prepared.skipped}`);
			});
		snapshotId = await phase("setup: template snapshot", () =>
			machines.snapshotEnvironment(
				WorkspaceId(templateVm as string),
				`fsf-snap-${tag}`,
			),
		);
	}
	for (let run = 1; run <= runs; run++) {
		console.info(`\n=== run ${run} ===`);
		const vmId = await phase("(a) new chat machine ready", async () => {
			const id = await machines.provisionSession(
				`fsf-chat-${tag}-${run}`,
				snapshotId as string,
			);
			made.push(id);
			await Promise.all(
				copiedSessionScratchResetCommands().map((command) =>
					machines.exec(id, command, 15_000),
				),
			);
			return id;
		});
		forgetRunningGuest(vmId);
		await phase("(d) first tool call", () =>
			machines.exec(vmId, "cd ~ && git --version >/dev/null && pwd", 30_000),
		);
		forgetRunningGuest(vmId);
		await phase("(c) desktop, new chat", async () => {
			const published = publishDesktopViewer(machines, vmId);
			const started = await ensureDesktopProcesses(machines, vmId);
			if (started.exitCode !== 0)
				throw new Error(`desktop failed: ${started.stderr.slice(-400)}`);
			await published;
			await viewerBanner(vmId);
		});
		// The proxy must refuse anything but this VM's own credential (the
		// template's throwaway one included, which nobody holds anyway).
		const refused = await viewerBanner(
			vmId,
			0,
			`Basic ${Buffer.from("ytimesy:wrong").toString("base64")}`,
		).then(
			() => false,
			() => true,
		);
		if (!refused)
			throw new Error("SECURITY: the viewer accepted a wrong credential");
		console.info("  viewer refused a wrong credential");
		if (!(await vncAuthenticates(vmId, desktopVncPassword(vmId))))
			throw new Error("x11vnc refused this VM's own password");
		if (await vncAuthenticates(vmId, "wrongpw1"))
			throw new Error("SECURITY: x11vnc accepted a wrong password");
		console.info("  x11vnc took this VM's password and refused a wrong one");
		forgetRunningGuest(vmId);
		await phase("(c) desktop, running chat", async () => {
			await machines.ensureRunning(vmId);
			const started = await ensureDesktopProcesses(machines, vmId);
			if (started.exitCode !== 0) throw new Error("desktop probe failed");
			await viewerBanner(vmId);
		});
		await pauseAndSettle(vmId);
		forgetRunningGuest(vmId);
		await phase("(b) idle chat wake + first command", async () => {
			await machines.ensureRunning(vmId);
			await machines.exec(vmId, "true", 15_000);
		});
		await pauseAndSettle(vmId);
		forgetRunningGuest(vmId);
		await phase("(c) desktop, idle chat", async () => {
			await machines.ensureRunning(vmId);
			const published = publishDesktopViewer(machines, vmId);
			const started = await ensureDesktopProcesses(machines, vmId);
			if (started.exitCode !== 0) throw new Error("desktop failed after wake");
			await published;
			await viewerBanner(vmId);
		});
	}
} finally {
	for (const id of [...made, ...(templateVm ? [templateVm] : [])])
		await client.vms
			.delete(id)
			.catch((e) => console.warn("delete failed", id, String(e)));
	if (ownSnapshot && snapshotId)
		await client.vms.snapshots.delete(snapshotId).catch(() => undefined);
	console.info("\nsummary (ms):");
	for (const [name, values] of Object.entries(results))
		console.info(`  ${name.padEnd(36)} ${values.join(", ")}`);
}
