import { Freestyle } from "freestyle";

if (!process.argv.includes("--run"))
	throw new Error("Explicit --run required for a disposable paid VM proof.");
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY ?? "" });
let vmId: string | undefined;
try {
	const created = await client.vms.create({
		slug: `ytimesy-usage-proof-${crypto.randomUUID().slice(0, 8)}`,
		snapshotId: "freestyle/ubuntu-sm",
		metadata: { purpose: "ytimesy-usage-proof" },
		firewall: { rules: [] },
		maxRunTotalSeconds: 20,
		automaticRestart: false,
		autoDeleteSeconds: 300,
	});
	vmId = created.vmId;
	for (let attempt = 0; attempt < 12; attempt++) {
		const data = await created.vm.data();
		console.info(
			JSON.stringify({
				state: data.state,
				totalRunSeconds: data.totalRunSeconds,
				maxRunTotalSeconds: data.maxRunTotalSeconds,
				resources: data.resources,
			}),
		);
		if (data.maxRunTotalSeconds !== 20 || data.totalRunSeconds == null)
			throw new Error("Provider cap/counter contract is not supported.");
		if (data.state === "paused" || data.state === "stopped") {
			let refused = false;
			try {
				await created.vm.start();
			} catch (error) {
				refused = (error as { status?: number }).status === 409;
			}
			if (!refused) throw new Error("Exhausted VM accepted a restart.");
			console.info(
				"PASS: native runtime cap paused execution and refused an unpaid restart.",
			);
			break;
		}
		if (attempt === 11)
			throw new Error("Provider did not pause within the bounded proof.");
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
} finally {
	if (vmId) {
		await client.vms.delete(vmId);
		console.info("Disposable proof VM deleted.");
	}
}
