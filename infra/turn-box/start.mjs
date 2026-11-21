// Runs as root before the turn box service starts (and so again whenever the
// service restarts): proves this EC2 instance's role to the edge, receives an
// identity for it, downloads the current program and writes the service's
// environment. No secret is baked into the image or the launch template: the
// proof is a signature made with the instance role's own short-lived keys.
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { signStsRequest } from "./sigv4.mjs";

const edge = process.env.YTIMESY_EDGE_URL;
const sha = (data) => createHash("sha256").update(data).digest("hex");

async function imds(path, token) {
	const response = await fetch(`http://169.254.169.254${path}`, {
		headers: { "X-aws-ec2-metadata-token": token },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error(`metadata ${path}: ${response.status}`);
	return response.text();
}

async function signedHeaders() {
	const token = await (
		await fetch("http://169.254.169.254/latest/api/token", {
			method: "PUT",
			headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" },
			signal: AbortSignal.timeout(5000),
		})
	).text();
	const role = (await imds("/latest/meta-data/iam/security-credentials/", token)).trim().split("\n")[0];
	const credentials = JSON.parse(await imds(`/latest/meta-data/iam/security-credentials/${role}`, token));
	return signStsRequest({
		accessKeyId: credentials.AccessKeyId,
		secretAccessKey: credentials.SecretAccessKey,
		token: credentials.Token,
		stamp: new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
	});
}

async function withRetry(label, run) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= 8) throw error;
			console.error(`${label} failed (${error.message}); retrying`);
			await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
		}
	}
}

const { identity } = await withRetry("enroll", async () => {
	const response = await fetch(`${edge}/box/v1/enroll`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ headers: await signedHeaders() }),
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) throw new Error(`edge answered ${response.status}`);
	return response.json();
});
const bundle = await withRetry("bundle", async () => {
	const response = await fetch(`${edge}/box/v1/bundle`, {
		headers: { authorization: `Bearer ${identity}` },
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) throw new Error(`edge answered ${response.status}`);
	return response.json();
});
const program = await withRetry("download", async () => {
	const response = await fetch(bundle.url, { signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`storage answered ${response.status}`);
	return gunzipSync(Buffer.from(await response.arrayBuffer()));
});
if (sha(program) !== bundle.sha256) throw new Error("the downloaded program does not match its checksum");
writeFileSync("/opt/ytimesy-turn-box/turn-box.mjs", program);
const id = (await (await fetch("http://169.254.169.254/latest/meta-data/instance-id", {
	headers: { "X-aws-ec2-metadata-token": await (await fetch("http://169.254.169.254/latest/api/token", { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" } })).text() },
})).text()).trim();
writeFileSync(
	"/run/ytimesy-turn-box.env",
	[
		"YTIMESY_MODEL_EXECUTION_TARGET=durable-object",
		`YTIMESY_EDGE_URL=${edge}`,
		`YTIMESY_BOX_IDENTITY=${identity}`,
		`YTIMESY_TURN_BOX_ID=${id}`,
		`YTIMESY_BUILD_ID=${bundle.version}`,
		"YTIMESY_BOX_EXIT_ON_REJECTED=1",
		"",
	].join("\n"),
	{ mode: 0o600 },
);
chmodSync("/run/ytimesy-turn-box.env", 0o600);
console.log(`enrolled ${id}, program ${bundle.version}`);
