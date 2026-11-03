import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import {
	snapshotSupportsRetention,
	WORKSPACE_RETENTION_SECONDS,
} from "#/domain/workspace-retention";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { retainedTreeDigest } from "#/server/adapters/freestyle/workspace-retention";

if (!process.argv.includes("--run"))
	throw new Error(
		"Explicit --run required for disposable snapshot verification.",
	);
const f = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY ?? "" });
const marker = randomUUID();
const source = await f.vms.create({
	slug: `ytimesy-retention-proof-${marker}`,
	snapshotId: "freestyle/ubuntu-sm",
	firewall: { rules: [] },
	maxRunTotalSeconds: 30,
	autoDeleteSeconds: 300,
	automaticRestart: false,
});
let snapshotId: string | undefined;
let cloneId: string | undefined;
try {
	await waitUntilVmRunning(source.vm, "Disposable recovery source");
	await source.vm.fs.mkdir("/home/ubuntu/recovery-proof");
	await source.vm.fs.writeTextFile(
		"/home/ubuntu/recovery-proof/.gitignore",
		".env\nlocal.bin\n",
	);
	await source.vm.fs.writeTextFile("/home/ubuntu/recovery-proof/.env", marker, {
		mode: 0o600,
	});
	await source.vm.fs.writeFile(
		"/home/ubuntu/recovery-proof/local.bin",
		new Uint8Array([0, 1, 2, 255]),
	);
	const expected = await retainedTreeDigest(source.vm, [
		"/home/ubuntu/recovery-proof",
	]);
	await source.vm.pause();
	const created = await source.vm.snapshot({
		autoDeleteSeconds: -1,
		ttlSeconds: -1,
		slug: `ytimesy-retention-image-${marker}`,
	});
	snapshotId = created.snapshotId;
	const snapshot = await f.vms.snapshots.get(snapshotId);
	if (
		!snapshotSupportsRetention({
			...snapshot,
			expectedSourceVmId: source.vmId,
			expiresAt: Date.now() + WORKSPACE_RETENTION_SECONDS * 1000,
		})
	)
		throw new Error(
			"Provider does not satisfy private 90-day recovery retention.",
		);
	const copy = await f.vms.create({
		snapshotId,
		firewall: { rules: [] },
		maxRunTotalSeconds: 20,
		autoDeleteSeconds: 300,
		automaticRestart: false,
	});
	cloneId = copy.vmId;
	await waitUntilVmRunning(copy.vm, "Disposable recovery verification");
	if (
		(await retainedTreeDigest(copy.vm, ["/home/ubuntu/recovery-proof"])) !==
		expected
	)
		throw new Error("Ignored file content or permissions changed on restore.");
	console.info(
		"PASS: materialized private full-state snapshot independently restored ignored text, binary data and permissions in an isolated copy; effective metadata supports 90 days.",
	);
} finally {
	if (cloneId) await f.vms.delete(cloneId);
	await f.vms.delete(source.vmId);
	if (snapshotId) await f.vms.snapshots.delete(snapshotId);
	console.info("Only disposable proof VMs and their snapshot were removed.");
}
