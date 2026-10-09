import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { closeDatabase, database } from "../src/server/adapters/database";
import { codexExternalTokens } from "../src/server/auth/codex-managed-auth";
import { probeSubscription } from "./subscription-egress-probe";

if (process.env.EDGE_SUBSCRIPTION_PROOF !== "1")
	throw new Error("Enable EDGE_SUBSCRIPTION_PROOF=1.");
const ref = "exampledevprojectref";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== ref ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(ref)
)
	throw new Error("Not the approved development database.");
const name = `ytimesy-subscription-proof-${randomUUID().slice(0, 8)}`;
const vpc = process.env.EDGE_SUBSCRIPTION_VPC_PROOF === "1";
const configuration = vpc
	? "wrangler.subscription-vpc-probe.jsonc"
	: "wrangler.subscription-probe.jsonc";
const origin = `https://${name}.example-account.workers.dev`;
const secret = randomUUID() + randomUUID();
let deployed = false;
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
			"Subscription proof control failed; secret output withheld.",
		);
	}
}
try {
	const rows = (
		await database().query<{ user_id: string; model: string }>(
			`select a.user_id, (select listed_model_id from agent_session s where s.user_id=a.user_id and s.harness='codex' and s.listed_model_id is not null order by updated_at desc limit 1) as model from agent_account a where a.provider='codex' and a.status='connected' and a.encrypted_codex_auth is not null`,
		)
	).rows;
	if (rows.length !== 1 || !rows[0].model)
		throw new Error("Requires one configured subscription owner.");
	const tokens = await codexExternalTokens(rows[0].user_id);
	const connection = {
		accessToken: tokens.accessToken,
		accountId: tokens.chatgptAccountId,
		model: rows[0].model,
	};
	if (!vpc)
		console.log(
			JSON.stringify({
				runtime: "local",
				catalog: await probeSubscription(connection, false),
				inference: await probeSubscription(connection, true),
			}),
		);
	// Cleanup attempts even when deployment outcome is uncertain.
	deployed = true;
	wrangler(["deploy", "--name", name]);
	wrangler(
		["secret", "bulk", "--name", name],
		JSON.stringify({
			PROBE_SECRET: secret,
			PROBE_ACCESS_TOKEN: connection.accessToken,
			PROBE_ACCOUNT_ID: connection.accountId,
			PROBE_MODEL: connection.model,
			PROBE_EXPIRES: String(Date.now() + 300_000),
		}),
	);
	for (const path of ["catalog", "inference"]) {
		let result: unknown;
		for (let attempt = 0; attempt < 20; attempt++) {
			const url = `${origin}/${path}`;
			const response = await fetch(url, {
				method: "POST",
				headers: await signDeliveryRequest(secret, "POST", url),
				signal: AbortSignal.timeout(40_000),
			});
			if (response.status === 503) {
				await response.body?.cancel();
				await delay(2_000);
				continue;
			}
			if (!response.ok)
				throw new Error(`Proof endpoint failed HTTP ${response.status}.`);
			result = await response.json();
			break;
		}
		if (!result) throw new Error("Probe deployment did not become ready.");
		console.log(
			JSON.stringify({
				runtime: vpc ? "cloudflare-vpc" : "cloudflare",
				endpoint: path,
				result,
			}),
		);
	}
} finally {
	try {
		if (deployed) {
			wrangler(["delete", name]);
			console.log("Disposable subscription probe deleted.");
		}
	} finally {
		await closeDatabase();
	}
}
