import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Freestyle, FreestyleApiError } from "freestyle";

const slug = "ytimesy-codex-proof";
const agentDirectory = "/home/ubuntu/ytimesy-agent";
const codex = `${agentDirectory}/node_modules/.bin/codex`;
const version = "0.152.1";
const client = new Freestyle();
const vm = client.vms.ref(slug);

async function requireProofVm() {
	const data = await vm.data();
	if (data.metadata?.purpose !== "codex-integration-proof") {
		throw new Error(
			"Refusing to operate on a VM without the proof ownership label",
		);
	}
	return data;
}

async function execute(command: string, timeoutMs = 15_000) {
	const result = await vm.exec({ command, timeoutMs });
	if (result.statusCode !== 0) {
		throw new Error(
			`Remote command failed with status ${result.statusCode}: ${result.stderr}`,
		);
	}
	return result.stdout;
}

/** A stable slug prevents a timed-out create from silently becoming a second VM. */
async function prepare() {
	try {
		await requireProofVm();
	} catch (error) {
		if (!(error instanceof FreestyleApiError) || error.status !== 404)
			throw error;
		await client.vms.create({
			slug,
			displayName: "ytimesy Codex integration proof",
			snapshotId: "freestyle/ubuntu-sm",
			metadata: { project: "ytimesy", purpose: "codex-integration-proof" },
			firewall: {
				rules: [{ action: "allow", source: {}, destination: { public: true } }],
			},
			idleTimeoutSeconds: 300,
			maxRunSeconds: 1800,
			ttlSeconds: 86400,
		});
	}
	await vm.start();
	console.log(
		await execute(
			`npm install --prefix ${agentDirectory} @openai/codex@${version} && ${codex} --version`,
			120_000,
		),
	);
}

async function login() {
	await requireProofVm();
	await vm.start();
	// The shell detaches login so an HTTP request ending does not terminate it.
	await execute(
		`umask 077; nohup ${codex} login --device-auth > ${agentDirectory}/login.log 2>&1 < /dev/null &`,
	);
	console.log(
		"Login started. Run login-code to retrieve the one-time authorization code.",
	);
}

async function verify() {
	await requireProofVm();
	await vm.start();
	const sourcePath = fileURLToPath(
		new URL("./codex-app-server.mjs", import.meta.url),
	);
	await vm.fs.writeTextFile(
		`${agentDirectory}/proof.mjs`,
		await readFile(sourcePath, "utf8"),
	);
	console.log(await execute(`node ${agentDirectory}/proof.mjs`, 150_000));
}

async function run(command: string | undefined) {
	switch (command) {
		case "prepare":
			return prepare();
		case "login":
			return login();
		case "login-code":
			await requireProofVm();
			console.log(await execute(`cat ${agentDirectory}/login.log`));
			return;
		case "status": {
			const data = await requireProofVm();
			console.log(
				JSON.stringify({
					vmId: data.id,
					state: data.state,
					expiresAfterSeconds: data.ttlSeconds,
				}),
			);
			console.log(await execute(`${codex} login status 2>&1 || true`));
			return;
		}
		case "verify":
			return verify();
		case "pause":
			await requireProofVm();
			await vm.pause();
			console.log("Proof VM paused.");
			return;
		case "delete":
			await requireProofVm();
			await vm.delete();
			console.log("Proof VM and its authentication state deleted.");
			return;
		default:
			throw new Error(
				"Usage: pnpm cloud:proof prepare|login|login-code|status|verify|pause|delete",
			);
	}
}

await Effect.runPromise(
	Effect.tryPromise(() => run(process.argv[2])).pipe(
		Effect.catchAll((error) =>
			Effect.sync(() => {
				const cause = error.error;
				const message =
					cause instanceof Error ? cause.message : "Cloud proof failed";
				const apiKey = process.env.FREESTYLE_API_KEY;
				console.error(
					apiKey ? message.replaceAll(apiKey, "[redacted]") : message,
				);
				process.exitCode = 1;
			}),
		),
	),
);
