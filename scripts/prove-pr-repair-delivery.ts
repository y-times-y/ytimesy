import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { closeDatabase, database } from "#/server/adapters/database";
import { GUEST_INTERNET_FIREWALL } from "#/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";

const suffix = randomUUID().slice(0, 8);
const workerName = `ytimesy-pr-repair-proof-${suffix}`;
const workflowName = `ytimesy-pr-repairs-proof-${suffix}`;
const sessionId = randomUUID();
const projectId = randomUUID();
const parentId = randomUUID();
const workspaceId = randomUUID();
const repositoryId = 8_000_000_000_000 + Number.parseInt(suffix, 16);
const fullName = `ytimesy-proof/repair-${suffix}`;
const deliveryId = randomUUID();
const temporary = await mkdtemp(join(tmpdir(), "ytimesy-repair-proof-"));
const configPath = join(temporary, "wrangler.json");
const key = randomBytes(32).toString("hex");
const githubSecret = randomBytes(32).toString("hex");
let vmId: string | undefined;
let workerAttempted = false;
let tail: ChildProcess | undefined;

function wrangler(args: string[]) {
	const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
		encoding: "utf8",
		stdio: "pipe",
	});
	if (result.status !== 0)
		throw new Error("Disposable Cloudflare proof operation failed.");
	return result.stdout;
}

async function main() {
	if (!process.argv.includes("--live"))
		throw new Error("Explicit --live required.");
	const reference = "exampledevprojectref";
	const url = new URL(process.env.DATABASE_URL ?? "");
	if (
		(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
			reference ||
		!url.username.includes(reference)
	)
		throw new Error("Not the approved development database.");
	const parent = await database().query<{
		id: string;
		user_id: string;
		project_id: string;
		repository_id: string;
		installation_id: string;
	}>(
		`select s.id,s.user_id,s.project_id,r.repository_id,r.installation_id
		from agent_session s join project p on p.id=s.project_id and p.user_id=s.user_id
		join project_repository r on r.project_id=p.id
		where s.parent_session_id is null and r.full_name='y-times-y/ytimesy' limit 1`,
	);
	const owner = parent.rows[0];
	if (!owner)
		throw new Error("No authorized development parent for the fixture.");
	await database().query(
		`insert into project(id,user_id,repository_id,installation_id,full_name,branch)
		values($1,$2,$3,$4,$5,'main')`,
		[projectId, owner.user_id, repositoryId, owner.installation_id, fullName],
	);
	await database().query(
		`insert into workspace(id,user_id,project_id,status) values($1,$2,$3,'ready')`,
		[workspaceId, owner.user_id, projectId],
	);
	await database().query(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,status,turn_status)
		values($1,$2,$3,$4,'codex','Disposable repair delivery proof','ready','idle')`,
		[parentId, owner.user_id, projectId, workspaceId],
	);
	await database().query(
		`insert into agent_session(id,user_id,project_id,harness,parent_session_id,title,status,turn_status,task_access,task_pull_request_url,workspace_id)
		values($1,$2,$3,'codex',$4,'Disposable repair delivery proof','ready','idle','read_write',$5,$6)`,
		[
			sessionId,
			owner.user_id,
			projectId,
			parentId,
			`https://github.com/${fullName}/pull/2147483647`,
			workspaceId,
		],
	);
	const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
	const created = await client.vms.create({
		slug: workerName,
		snapshotId: "freestyle/ubuntu-sm",
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 900,
		maxRunTotalSeconds: 600,
		idleTimeoutSeconds: 600,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-disposable-repair-proof" },
	});
	vmId = created.vmId;
	const running = await waitUntilVmRunning(created.vm, "Repair delivery proof");
	if (running.resources.cpu !== 2 || running.resources.memory !== 4096)
		throw new Error("Disposable executor exceeds its approved proof size.");
	const entry = join(temporary, "executor.mjs");
	await build({
		stdin: {
			contents: `import { startModelWorkflowExecutor } from './src/server/jobs/model-workflow-executor.ts';
import { createFreestyleWorkspaceMachines } from './src/server/adapters/freestyle/workspace-machines.ts';
startModelWorkflowExecutor(createFreestyleWorkspaceMachines('no-inference-or-compute-authority')).then(()=>console.log('repair-proof-ready'));`,
			resolveDir: process.cwd(),
			loader: "ts",
		},
		outfile: entry,
		bundle: true,
		platform: "node",
		format: "esm",
		banner: {
			js: "import { createRequire as proofCreateRequire } from 'node:module'; import { fileURLToPath as proofFileURLToPath } from 'node:url'; import { dirname as proofDirname } from 'node:path'; const require = proofCreateRequire(import.meta.url); const __filename = proofFileURLToPath(import.meta.url); const __dirname = proofDirname(__filename);",
		},
		external: ["pg-native"],
		logLevel: "silent",
	});
	const guestRoot = "/home/ubuntu/ytimesy-repair-proof";
	await created.vm.exec({
		command: `mkdir -p ${guestRoot}`,
		timeoutMs: 10000,
	});
	await created.vm.fs.writeTextFile(
		`${guestRoot}/executor.mjs`,
		await readFile(entry, "utf8"),
	);
	const ca = url.searchParams.get("sslrootcert") ?? ".secrets/supabase-ca.crt";
	url.searchParams.set("sslrootcert", `${guestRoot}/ca.crt`);
	await created.vm.fs.writeTextFile(
		`${guestRoot}/ca.crt`,
		await readFile(ca, "utf8"),
	);
	const env = {
		DATABASE_URL: url.href,
		DATABASE_POOL_MAX: "1",
		APP_URL: "http://127.0.0.1:3000",
		BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
		GITHUB_OAUTH_CLIENT_ID: "proof-not-authorized",
		GITHUB_OAUTH_CLIENT_SECRET: "proof-not-authorized",
		GITHUB_APP_CLIENT_ID: "proof-not-authorized",
		GITHUB_APP_CLIENT_SECRET: "proof-not-authorized",
		GITHUB_APP_SLUG: "ytimesy-cloud",
		YTIMESY_MODEL_WORKFLOW_SECRET: key,
		YTIMESY_PR_REPAIR_ENABLED: "1",
	};
	await created.vm.fs.writeTextFile(
		`${guestRoot}/.env`,
		Object.entries(env)
			.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
			.join("\n"),
		{ mode: 0o600 },
	);
	const started = await created.vm.exec({
		command: `cd ${guestRoot} && (if [ -s /usr/local/nvm/nvm.sh ]; then . /usr/local/nvm/nvm.sh; elif [ -s /home/ubuntu/.nvm/nvm.sh ]; then . /home/ubuntu/.nvm/nvm.sh; fi; nohup node --env-file=.env executor.mjs >proof.log 2>&1 </dev/null &)`,
		timeoutMs: 10000,
	});
	if (started.statusCode !== 0)
		throw new Error("Disposable executor did not start.");
	const ready = await created.vm.exec({
		command: `for i in $(seq 1 30); do if curl -s -X POST -o /dev/null -w '%{http_code}' http://127.0.0.1:8789/pr-repair-event | grep -q 401; then exit 0; fi; sleep 1; done; exit 1`,
		timeoutMs: 35000,
	});
	if (ready.statusCode !== 0) {
		const log = await created.vm.fs.readTextFile(`${guestRoot}/proof.log`);
		const safeLog = Object.values(env)
			.filter((value) => value.length >= 8)
			.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), log)
			.replace(/https?:\/\/\S+|postgres(?:ql)?:\/\/\S+/g, "[redacted URL]");
		console.info(`Disposable startup diagnostic: ${safeLog.slice(-1600)}`);
		console.info(
			`Readiness diagnostic: ${ready.statusCode}, ${(ready.stdout ?? "").slice(-200)}, ${(ready.stderr ?? "").slice(-200)}`,
		);
		const classification =
			[
				"Dynamic require",
				"Cannot find module",
				"ERR_REQUIRE_ESM",
				"ERR_INVALID_ARG_TYPE",
				"Missing or invalid server configuration",
				"command not found",
				"bad option",
				"Cannot use",
				"not defined",
			].find((pattern) => log.includes(pattern)) ??
			"unclassified startup failure";
		throw new Error(`Disposable executor readiness failed: ${classification}.`);
	}
	const hostname = `ytimesy-model-executor-${vmId.replaceAll("-", "")}.style.dev`;
	await client.tls.rules.create({
		action: "allow",
		domain: hostname,
		source: { public: true },
		destination: { vmId, port: 8789 },
	});
	const transportUrl = `https://${hostname}/pr-repair-event`;
	const transportBody = JSON.stringify({
		deliveryId: randomUUID(),
		signal: {
			repositoryId,
			fullName: "ytimesy-proof/no-candidates",
			installationId: Number(owner.installation_id),
			headSha: "0".repeat(40),
			kind: "check_run",
			sourceId: 2147483647,
			prNumber: null,
		},
	});
	const transport = await fetch(transportUrl, {
		method: "POST",
		headers: await signDeliveryRequest(
			key,
			"POST",
			transportUrl,
			transportBody,
		),
		body: transportBody,
		signal: AbortSignal.timeout(20000),
	});
	await transport.body?.cancel();
	if (transport.status !== 200)
		throw new Error(
			`Disposable remote executor preflight returned HTTP ${transport.status}.`,
		);
	console.info("Signed remote Node/database preflight passed.");
	const base = JSON.parse(await readFile("wrangler.pr-repair.jsonc", "utf8"));
	await writeFile(
		configPath,
		JSON.stringify({
			...base,
			name: workerName,
			main: join(process.cwd(), "src/workflows/pr-repair.ts"),
			vars: { REPAIR_EXECUTOR_URL: `https://${hostname}` },
			workflows: [
				{
					binding: "PR_REPAIRS",
					name: workflowName,
					class_name: "PrRepairWorkflow",
				},
			],
		}),
	);
	const secretsFile = join(temporary, "secrets.json");
	await writeFile(
		secretsFile,
		JSON.stringify({
			GITHUB_PR_REPAIR_WEBHOOK_SECRET: githubSecret,
			MODEL_WORKFLOW_SECRET: key,
		}),
		{ mode: 0o600 },
	);
	workerAttempted = true;
	const deployed = wrangler([
		"deploy",
		"--config",
		configPath,
		"--secrets-file",
		secretsFile,
	]);
	const origin = deployed.match(
		new RegExp(`https://${workerName}\\.[a-z0-9-]+\\.workers\\.dev`),
	)?.[0];
	if (!origin)
		throw new Error("Deployment did not return its disposable endpoint.");
	const endpoint = `${origin}/github-repair`;
	console.info(
		"Disposable endpoint deployed; checking authentication boundary.",
	);
	let tailOutput = "";
	tail = spawn(
		"pnpm",
		["exec", "wrangler", "tail", "--config", configPath, "--format", "json"],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	tail.stdout?.on("data", (chunk) => {
		tailOutput = (tailOutput + chunk.toString()).slice(-12000);
	});
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const payload = JSON.stringify({
		action: "completed",
		repository: {
			id: repositoryId,
			full_name: fullName,
		},
		installation: { id: Number(owner.installation_id) },
		check_run: {
			id: 2147483647,
			head_sha: "0".repeat(40),
			conclusion: "failure",
		},
	});
	let unsignedStatus = 0;
	const deploymentDeadline = Date.now() + 45000;
	do {
		const unsigned = await fetch(endpoint, {
			method: "POST",
			body: payload,
			signal: AbortSignal.timeout(15000),
		});
		unsignedStatus = unsigned.status;
		await unsigned.body?.cancel();
		if (unsignedStatus === 401 || ![404, 500, 503].includes(unsignedStatus))
			break;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	} while (Date.now() < deploymentDeadline);
	if (unsignedStatus !== 401) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const messages = [
			...tailOutput.matchAll(/"(?:message|name)"\s*:\s*"([^"\n]{1,400})"/g),
		]
			.map((match) => match[1])
			.join("; ");
		console.info(
			`Disposable ingress diagnostic: ${messages.replace(/https?:\/\/\S+/g, "[redacted URL]") || "No exception received."}`,
		);
		throw new Error(
			`Unsigned remote delivery returned HTTP ${unsignedStatus}; expected 401.`,
		);
	}
	const headers = {
		"x-github-event": "check_run",
		"x-github-delivery": deliveryId,
		"x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update(payload).digest("hex")}`,
	};
	// A new endpoint can serve HTTP before its first Workflow version has propagated.
	await new Promise((resolve) => setTimeout(resolve, 30000));
	for (let index = 0; index < 2; index++) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: payload,
			signal: AbortSignal.timeout(15000),
		});
		await response.body?.cancel();
		if (response.status !== 202)
			throw new Error("Signed remote delivery was not accepted.");
	}
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const result = await database().query(
			"select count(*)::int n from agent_pr_repair_event where delivery_id=$1 and session_id=$2",
			[deliveryId, sessionId],
		);
		if (result.rows[0]?.n === 1) break;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const stored = await database().query(
		"select status,counted from agent_pr_repair_event where delivery_id=$1 and session_id=$2",
		[deliveryId, sessionId],
	);
	if (
		stored.rowCount !== 1 ||
		stored.rows[0].status !== "pending" ||
		stored.rows[0].counted
	) {
		const diagnostic = wrangler([
			"workflows",
			"instances",
			"describe",
			workflowName,
			`repair-${deliveryId}`,
			"--config",
			configPath,
			"--json",
		]);
		console.info(
			`Workflow diagnostic: ${diagnostic.slice(-2500).replace(/https?:\/\/\S+/g, "[redacted URL]")}`,
		);
		throw new Error("Remote event was not durably staged exactly once.");
	}
	const turns = await database().query(
		"select 1 from api_turn where session_id=$1",
		[sessionId],
	);
	if (turns.rowCount)
		throw new Error("Delivery proof unexpectedly started inference.");
	let state = JSON.parse(
		wrangler([
			"workflows",
			"instances",
			"describe",
			workflowName,
			`repair-${deliveryId}`,
			"--config",
			configPath,
			"--json",
		]),
	);
	for (let index = 0; state.status !== "complete" && index < 10; index++) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		state = JSON.parse(
			wrangler([
				"workflows",
				"instances",
				"describe",
				workflowName,
				`repair-${deliveryId}`,
				"--config",
				configPath,
				"--json",
			]),
		);
	}
	if (state.status !== "complete")
		throw new Error("Disposable delivery workflow did not complete.");
	console.info(
		JSON.stringify({
			unsigned: 401,
			signed: 202,
			duplicateReceipts: stored.rowCount,
			inferenceRequests: 0,
			workflowStatus: state.status,
		}),
	);
}

const failures: Error[] = [];
try {
	await main();
} catch (error) {
	failures.push(
		error instanceof Error ? error : new Error("Disposable proof failed."),
	);
} finally {
	tail?.kill("SIGTERM");
	const cleanupFailures: string[] = [];
	async function cleanup(label: string, action: () => Promise<unknown>) {
		try {
			await action();
		} catch {
			cleanupFailures.push(label);
		}
	}
	if (vmId)
		await cleanup("executor VM", async () => {
			await new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY }).vms
				.ref(vmId as string)
				.delete();
			console.info("Disposable repair executor deleted.");
		});
	if (workerAttempted) {
		await cleanup("Cloudflare workflow", async () => {
			wrangler(["workflows", "delete", workflowName, "--config", configPath]);
		});
		await cleanup("Cloudflare endpoint", async () => {
			wrangler(["delete", "--config", configPath, "--force"]);
		});
	}
	await cleanup("database fixtures", async () => {
		await database().query(
			"delete from agent_session where project_id=$1 and title='Disposable repair delivery proof'",
			[projectId],
		);
		await database().query("delete from project where id=$1 and full_name=$2", [
			projectId,
			fullName,
		]);
	});
	await cleanup("database connection", closeDatabase);
	await cleanup("private temporary files", () =>
		rm(temporary, { recursive: true, force: true }),
	);
	if (cleanupFailures.length)
		failures.push(
			new Error(`Proof cleanup needs attention: ${cleanupFailures.join(", ")}`),
		);
	else
		console.info("Disposable proof resources and database fixtures deleted.");
}
if (failures.length)
	throw new AggregateError(failures, "Disposable delivery proof failed.");
