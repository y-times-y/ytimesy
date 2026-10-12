import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

// Fixed development surface. An absent sender makes this proof read-only: no inference or VM calls.
const configuration = "wrangler.edge-executor.jsonc";
const url =
	"https://ytimesy-edge-executor-development.example-account.workers.dev/jobs/start";
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
async function admit() {
	for (let propagation = 0; propagation < 30; propagation++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(secret, "POST", url, body),
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 202)
			return ((await response.json()) as { state: string }).state;
		if (response.status !== 503)
			throw new Error(`Background proof rejected (${response.status}).`);
		await delay(2000);
	}
	throw new Error("Background proof gate did not propagate.");
}
try {
	wrangler(["secret", "put", "BACKGROUND_EXECUTION_ENABLED"], "1");
	console.log("Development background gate enabled for the read-only proof.");
	// Re-admitting the same job ID reports the one runner's state without rerunning it.
	let state = await admit();
	for (
		let attempt = 0;
		attempt < 12 && !["done", "failed"].includes(state);
		attempt++
	) {
		await delay(1000);
		state = await admit();
	}
	if (state !== "done")
		throw new Error(`Background proof job ended as ${state}.`);
	console.log(
		"Live background job completed; repeated admission reused one identity. No inference or VMs were used.",
	);
} finally {
	wrangler(["secret", "put", "BACKGROUND_EXECUTION_ENABLED"], "0");
}
