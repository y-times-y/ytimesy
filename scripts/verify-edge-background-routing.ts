import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

// Fixed development surface. An absent sender makes this proof read-only: no inference or VM calls.
const configuration = "wrangler.edge-executor.jsonc";
const workflow = "ytimesy-background-jobs-development";
const url =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev/jobs/start";
const id = randomUUID();
const root = process.env.BETTER_AUTH_SECRET;
if (!root || root.length < 32)
	throw new Error("Development signing configuration missing.");
const secret =
	process.env.YTIMESY_BACKGROUND_WORKFLOW_SECRET ||
	createHmac("sha256", root)
		.update("ytimesy:background-workflows:development:v1")
		.digest("hex");
const body = JSON.stringify({
	id,
	kind: "peer-message",
	userId: `nonexistent-routing-proof-${id}`,
	senderId: randomUUID(),
	recipientId: randomUUID(),
	message: "Non-billable routing proof; no sender exists.",
});
function wrangler(args: string[], input?: string) {
	try {
		return execFileSync(
			"pnpm",
			["exec", "wrangler", ...args, "--config", configuration],
			{
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 60_000,
			},
		);
	} catch {
		throw new Error(
			"Development background proof command failed; secrets were not logged.",
		);
	}
}
let requested = false;
try {
	wrangler(["secret", "put", "BACKGROUND_EXECUTION_ENABLED"], "1");
	console.log("Development background gate enabled for the read-only proof.");
	for (let repeat = 0; repeat < 2; repeat++) {
		requested = true;
		let accepted = false;
		for (let propagation = 0; propagation < 30; propagation++) {
			const response = await fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", url, body),
				signal: AbortSignal.timeout(10_000),
			});
			if (response.status === 202) {
				accepted = true;
				break;
			}
			if (response.status !== 503)
				throw new Error(`Background proof rejected (${response.status}).`);
			await delay(2000);
		}
		if (!accepted) throw new Error("Background proof gate did not propagate.");
	}
	console.log("Repeated background admission accepted.");
	let completed = false;
	for (let attempt = 0; attempt < 12; attempt++) {
		const status = JSON.parse(
			wrangler(["workflows", "instances", "describe", workflow, id, "--json"]),
		) as { status: string };
		if (status.status === "complete") {
			completed = true;
			break;
		}
		if (status.status === "errored")
			throw new Error("Background proof Workflow failed.");
		await delay(1000);
	}
	if (!completed)
		throw new Error("Background proof did not complete within its bound.");
	console.log(
		"Live background Workflow completed; repeated admission reused one identity. No inference or VMs were used.",
	);
} finally {
	try {
		wrangler(["secret", "put", "BACKGROUND_EXECUTION_ENABLED"], "0");
	} finally {
		if (requested) {
			const instances = JSON.parse(
				wrangler(["workflows", "instances", "list", workflow, "--json"]),
			) as { id: string }[];
			if (instances.some((instance) => instance.id === id))
				wrangler(["workflows", "instances", "delete", workflow, id, "--json"]);
		}
	}
}
